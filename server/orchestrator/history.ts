import { randomUUID } from "node:crypto";
import { getDashboardDb } from "../db/dashboard.ts";
import type { HistoryEntry, StepKind, StepResult, WorkflowInstance } from "./types.ts";

type DbHistoryRow = {
  id: string;
  instance_id: string;
  step_index: number;
  kind: string;
  payload_json: string;
  result_json: string | null;
  status: string;
  started_at: number;
  finished_at: number | null;
};

type DbInstanceRow = {
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
};

function rowToHistoryEntry(row: DbHistoryRow): HistoryEntry {
  return {
    id: row.id,
    workflowInstanceId: row.instance_id,
    stepIndex: row.step_index,
    kind: row.kind as StepKind,
    payload_json: row.payload_json,
    result_json: row.result_json,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as HistoryEntry["status"],
  };
}

function rowToInstance(row: DbInstanceRow): WorkflowInstance {
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

export function appendStep(
  instanceId: string,
  stepIndex: number,
  kind: StepKind,
  payload: unknown,
): string {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not available");

  const id = randomUUID();
  const now = Date.now();

  db.query(
    `INSERT INTO orchestrator_history (id, instance_id, step_index, kind, payload_json, result_json, status, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'running', ?, NULL)`,
  ).run(id, instanceId, stepIndex, kind, JSON.stringify(payload), now);

  return id;
}

export function updateStep(
  id: string,
  result: StepResult,
): void {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not available");

  db.query(
    `UPDATE orchestrator_history SET result_json = ?, status = ?, finished_at = ? WHERE id = ?`,
  ).run(JSON.stringify(result), result.status, Date.now(), id);
}

export function getHistory(instanceId: string): HistoryEntry[] {
  const db = getDashboardDb();
  if (!db) return [];

  const rows = db
    .query(`SELECT * FROM orchestrator_history WHERE instance_id = ? ORDER BY step_index ASC`)
    .all(instanceId) as DbHistoryRow[];

  return rows.map(rowToHistoryEntry);
}

export function getInstance(id: string): WorkflowInstance | null {
  const db = getDashboardDb();
  if (!db) return null;

  const row = db
    .query(`SELECT * FROM orchestrator_instances WHERE id = ?`)
    .get(id) as DbInstanceRow | null;

  return row ? rowToInstance(row) : null;
}

export function upsertInstance(instance: WorkflowInstance): void {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB not available");

  db.query(
    `INSERT INTO orchestrator_instances
       (id, definition_name, run_id, workflow_id, status, current_step_index, created_at, finished_at, error, parent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       current_step_index = excluded.current_step_index,
       finished_at = excluded.finished_at,
       error = excluded.error,
       parent_instance_id = excluded.parent_instance_id`,
  ).run(
    instance.id,
    instance.definitionName,
    instance.runId,
    instance.workflowId,
    instance.status,
    instance.currentStepIndex,
    instance.createdAt,
    instance.finishedAt,
    instance.error,
    instance.parentInstanceId ?? null,
  );
}
