import { randomUUID } from "node:crypto";
import { getDashboardDb } from "../db/dashboard.ts";
import { appendStep, getHistory, updateStep, upsertInstance, getInstance } from "./history.ts";
import { acquireLane, releaseLane } from "./lanes.ts";
import type {
  StepKind,
  StepRequest,
  StepResult,
  WorkflowCtx,
  WorkflowDef,
  WorkflowInstance,
} from "./types.ts";

const SPAWN_PASS_LANE = "builder-passes";

const definitionRegistry = new Map<string, WorkflowDef>();

export function registerWorkflowDefinition(name: string, def: WorkflowDef): void {
  definitionRegistry.set(name, def);
}

export function getWorkflowDefinition(name: string): WorkflowDef | undefined {
  return definitionRegistry.get(name);
}

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export type StepHandlers = Record<
  StepKind,
  (payload: unknown, instanceId: string) => Promise<StepResult>
>;

export function createSpawnChildHandler(
  stepHandlers: StepHandlers,
): (payload: unknown, parentInstanceId: string) => Promise<StepResult> {
  return async (payload: unknown, parentInstanceId: string): Promise<StepResult> => {
    const p = payload as { definitionName: string; input?: unknown } | null;
    if (!p || typeof p.definitionName !== "string") {
      return { status: "failed", error: "spawn-child: missing definitionName" };
    }

    const def = definitionRegistry.get(p.definitionName);
    if (!def) {
      return { status: "failed", error: `spawn-child: unknown workflow "${p.definitionName}"` };
    }

    const parent = getInstance(parentInstanceId);
    if (!parent) {
      return { status: "failed", error: "spawn-child: parent instance not found" };
    }

    const childId = `oi_${randomUUID()}`;
    const child: WorkflowInstance = {
      id: childId,
      definitionName: p.definitionName,
      runId: parent.runId,
      workflowId: parent.workflowId,
      status: "running",
      currentStepIndex: 0,
      createdAt: Date.now(),
      finishedAt: null,
      error: null,
      parentInstanceId: parentInstanceId,
    };
    upsertInstance(child);

    const childCtx = createWorkflowCtx(childId);
    const gen = def(childCtx);
    const childHistory = getHistory(childId);

    let stepIndex = 0;
    let next: IteratorResult<StepRequest, void>;
    next = gen.next();

    while (!next.done) {
      const yielded = next.value;
      if (!isStepRequest(yielded)) {
        updateStepStatus(childId, "failed", "non-deterministic yield");
        upsertInstance({ ...child, status: "failed", currentStepIndex: stepIndex, finishedAt: Date.now(), error: "non-deterministic yield" });
        return { status: "failed", error: `child "${p.definitionName}": non-deterministic yield` };
      }

      const historyId = appendStep(childId, stepIndex, yielded.kind, yielded.payload);

      let result: StepResult;
      try {
        const handler = stepHandlers[yielded.kind];
        if (!handler) {
          result = { status: "failed", error: `no handler for step kind "${yielded.kind}"` };
        } else {
          result = await handler(yielded.payload, childId);
        }
      } catch (err) {
        result = {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }

      updateStep(historyId, result);

      if (result.status === "cancelled" || result.status === "failed") {
        upsertInstance({
          ...child,
          status: result.status === "cancelled" ? "cancelled" : "failed",
          currentStepIndex: stepIndex,
          finishedAt: Date.now(),
          error: result.error ?? null,
        });
        return {
          status: result.status === "cancelled" ? "cancelled" : "failed",
          error: `child "${p.definitionName}": ${result.error ?? result.status}`,
          output: { childId, childStatus: result.status },
        };
      }

      if (result.status === "blocked") {
        upsertInstance({
          ...child,
          status: "blocked",
          currentStepIndex: stepIndex,
        });
        return {
          status: "blocked",
          error: `child "${p.definitionName}": blocked`,
          output: { childId, childStatus: "blocked" },
        };
      }

      stepIndex++;
      upsertInstance({ ...child, currentStepIndex: stepIndex });
      next = gen.next(result);
    }

    upsertInstance({
      ...child,
      status: "complete",
      currentStepIndex: stepIndex,
      finishedAt: Date.now(),
    });

    return {
      status: "complete",
      output: { childId, childStatus: "complete", stepsExecuted: stepIndex },
    };
  };
}

function updateStepStatus(instanceId: string, status: StepResult["status"], error: string | null): void {
  const db = getDashboardDb();
  if (!db) return;
  const rows = db
    .query(`SELECT id FROM orchestrator_history WHERE instance_id = ? ORDER BY step_index DESC LIMIT 1`)
    .all(instanceId) as Array<{ id: string }>;
  if (rows.length > 0) {
    updateStep(rows[0].id, { status, error: error ?? undefined });
  }
}

export function createWorkflowCtx(instanceId: string): WorkflowCtx {
  const makeRequest =
    (kind: StepKind) =>
    (payload: unknown = {}): StepRequest => ({ kind, payload });

  return {
    spawnPass: makeRequest("spawn-pass") as WorkflowCtx["spawnPass"],
    runValidation: makeRequest("run-validation") as WorkflowCtx["runValidation"],
    waitSignal: makeRequest("wait-signal") as WorkflowCtx["waitSignal"],
    waitTimer: makeRequest("wait-timer") as WorkflowCtx["waitTimer"],
    spawnChild: makeRequest("spawn-child") as WorkflowCtx["spawnChild"],
    pauseForApproval: makeRequest("pause-approval") as WorkflowCtx["pauseForApproval"],
    logToVault: makeRequest("log-vault") as WorkflowCtx["logToVault"],
  };
}

function isStepRequest(value: unknown): value is StepRequest {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in (value as object) &&
    typeof (value as StepRequest).kind === "string"
  );
}

export async function executeWorkflow(
  def: WorkflowDef,
  instance: WorkflowInstance,
  stepHandlers: StepHandlers,
): Promise<WorkflowInstance> {
  const ctx = createWorkflowCtx(instance.id);
  const gen = def(ctx);
  const history = getHistory(instance.id);

  let stepIndex = 0;
  let next: IteratorResult<StepRequest, void>;
  // Advance into the generator to get the first yield
  next = gen.next();

  // Fast-forward through already-completed steps (replay phase)
  while (stepIndex < instance.currentStepIndex && !next.done) {
    if (!isStepRequest(next.value)) {
      throw new OrchestratorError("non-deterministic yield");
    }

    const historicEntry = history[stepIndex];
    const result: StepResult = historicEntry?.result_json
      ? (JSON.parse(historicEntry.result_json) as StepResult)
      : { status: "complete" };

    next = gen.next(result);
    stepIndex++;
  }

  // Execute new steps
  while (!next.done) {
    const yielded = next.value;

    if (!isStepRequest(yielded)) {
      throw new OrchestratorError("non-deterministic yield");
    }

    // Enforce concurrency lane for spawn-pass steps
    if (yielded.kind === "spawn-pass") {
      const acquired = acquireLane(SPAWN_PASS_LANE);
      if (!acquired) {
        const blockedResult: StepResult = { status: "blocked", error: "lane-full" };
        instance = {
          ...instance,
          status: "blocked",
          currentStepIndex: stepIndex,
        };
        upsertInstance(instance);
        return instance;
      }
    }

    const historyId = appendStep(instance.id, stepIndex, yielded.kind, yielded.payload);

    const handler = stepHandlers[yielded.kind];
    let result: StepResult;

    try {
      result = await handler(yielded.payload, instance.id);
    } catch (err) {
      result = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (yielded.kind === "spawn-pass") {
        releaseLane(SPAWN_PASS_LANE);
      }
    }

    updateStep(historyId, result);

    if (result.status === "cancelled" || result.status === "failed") {
      instance = {
        ...instance,
        status: result.status === "cancelled" ? "cancelled" : "failed",
        currentStepIndex: stepIndex,
        finishedAt: Date.now(),
        error: result.error ?? null,
      };
      upsertInstance(instance);
      return instance;
    }

    if (result.status === "blocked") {
      instance = {
        ...instance,
        status: "blocked",
        currentStepIndex: stepIndex,
      };
      upsertInstance(instance);
      return instance;
    }

    stepIndex++;
    instance = { ...instance, currentStepIndex: stepIndex };
    upsertInstance(instance);

    next = gen.next(result);
  }

  instance = {
    ...instance,
    status: "complete",
    currentStepIndex: stepIndex,
    finishedAt: Date.now(),
  };
  upsertInstance(instance);
  return instance;
}
