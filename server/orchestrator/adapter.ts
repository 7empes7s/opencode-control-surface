import { randomUUID } from "node:crypto";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { appendStep, getHistory, upsertInstance, updateStep, getInstance } from "./history.ts";
import { executeWorkflow, type StepHandlers } from "./engine.ts";
import { buildUntilDone } from "./definitions.ts";
import type { WorkflowInstance, StepResult } from "./types.ts";

export function createOrchestratorInstance(
  runId: string,
  workflowId: string,
  parentInstanceId?: string | null,
): string {
  const id = `oi_${randomUUID()}`;
  const instance: WorkflowInstance = {
    id,
    definitionName: "buildUntilDone",
    runId,
    workflowId,
    status: "running",
    currentStepIndex: 0,
    createdAt: Date.now(),
    finishedAt: null,
    error: null,
    parentInstanceId: parentInstanceId ?? null,
  };
  upsertInstance(instance);

  const db = getDashboardDb();
  if (db) {
    db.query(
      `UPDATE builder_runs SET orchestrator_instance_id = ? WHERE id = ?`,
    ).run(id, runId);
  }

  return id;
}

export async function advanceOrchestratorInstance(
  instanceId: string,
  stepHandlers: StepHandlers,
): Promise<WorkflowInstance | null> {
  const instance = getInstance(instanceId);
  if (!instance || instance.status !== "running") return instance;

  return executeWorkflow(buildUntilDone, instance, stepHandlers);
}

export function findInstanceByRunId(runId: string): WorkflowInstance | null {
  const db = getDashboardDb();
  if (!db) return null;

  const row = db
    .query(`SELECT * FROM orchestrator_instances WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(runId) as {
      id: string;
      definition_name: string;
      run_id: string;
      workflow_id: string;
      status: string;
      current_step_index: number;
      created_at: number;
      finished_at: number | null;
      error: string | null;
      parent_instance_id: string | null;
    } | null;

  if (!row) return null;

  return {
    id: row.id,
    definitionName: row.definition_name,
    runId: row.run_id,
    workflowId: row.workflow_id,
    status: row.status as WorkflowInstance["status"],
    currentStepIndex: row.current_step_index,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    error: row.error,
    parentInstanceId: row.parent_instance_id,
  };
}

export function recordBuilderPassResult(
  instanceId: string,
  passSequence: number,
  result: StepResult,
): WorkflowInstance | null {
  const instance = getInstance(instanceId);
  if (!instance) return null;

  const history = getHistory(instanceId);
  const hasValidation = history.some((entry) => entry.kind === "run-validation");
  let nextStepIndex = history.reduce((max, entry) => Math.max(max, entry.stepIndex + 1), 0);

  if (!hasValidation) {
    const validationId = appendStep(instanceId, nextStepIndex, "run-validation", {});
    updateStep(validationId, { status: "complete" });
    nextStepIndex++;
  }

  const existingPassStep = getHistory(instanceId).find((entry) => {
    if (entry.kind !== "spawn-pass") return false;
    try {
      const payload = JSON.parse(entry.payload_json || "{}") as { sequence?: unknown };
      return payload.sequence === passSequence;
    } catch {
      return false;
    }
  });

  if (existingPassStep) {
    updateStep(existingPassStep.id, result);
  } else {
    const stepId = appendStep(instanceId, nextStepIndex, "spawn-pass", { sequence: passSequence });
    updateStep(stepId, result);
    nextStepIndex++;
  }

  const status: WorkflowInstance["status"] =
    result.status === "failed" ? "failed" :
    result.status === "cancelled" ? "cancelled" :
    result.status === "blocked" ? "blocked" :
    ((result.output as { done?: boolean } | undefined)?.done ? "complete" : "running");

  const updated: WorkflowInstance = {
    ...instance,
    status,
    currentStepIndex: Math.max(nextStepIndex, instance.currentStepIndex),
    finishedAt: status === "running" || status === "blocked" ? null : Date.now(),
    error: result.status === "failed" || result.status === "blocked" ? (result.error ?? null) : null,
  };
  upsertInstance(updated);
  return updated;
}

export function getOrchestratorInstance(instanceId: string): WorkflowInstance | null {
  return getInstance(instanceId);
}

export function listOrchestratorInstances(limit = 50): WorkflowInstance[] {
  const db = getDashboardDb();
  if (!db) return [];

  const rows = db
    .query(
      `SELECT * FROM orchestrator_instances ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string;
      definition_name: string;
      run_id: string;
      workflow_id: string;
      status: string;
      current_step_index: number;
      created_at: number;
      finished_at: number | null;
      error: string | null;
      parent_instance_id: string | null;
    }>;

  return rows.map((r) => ({
    id: r.id,
    definitionName: r.definition_name,
    runId: r.run_id,
    workflowId: r.workflow_id,
    status: r.status as WorkflowInstance["status"],
    currentStepIndex: r.current_step_index,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    error: r.error,
    parentInstanceId: r.parent_instance_id,
  }));
}

export function getInstanceWithHistory(instanceId: string): {
  instance: WorkflowInstance | null;
  history: Array<{
    id: string;
    stepIndex: number;
    kind: string;
    payload: unknown;
    result: unknown;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    durationMs: number | null;
  }>;
} {
  const instance = getInstance(instanceId);
  const db = getDashboardDb();
  if (!db) return { instance, history: [] };

  const rows = db
    .query(
      `SELECT * FROM orchestrator_history WHERE instance_id = ? ORDER BY step_index ASC`,
    )
    .all(instanceId) as Array<{
      id: string;
      instance_id: string;
      step_index: number;
      kind: string;
      payload_json: string;
      result_json: string | null;
      status: string;
      started_at: number;
      finished_at: number | null;
    }>;

  const history = rows.map((r) => ({
    id: r.id,
    stepIndex: r.step_index,
    kind: r.kind,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.finished_at ? r.finished_at - r.started_at : null,
  }));

  return { instance, history };
}
