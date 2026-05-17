import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { executeWorkflow, createWorkflowCtx, createSpawnChildHandler, registerWorkflowDefinition, type StepHandlers, OrchestratorError } from "./engine.ts";
import { appendStep, updateStep, upsertInstance, getInstance } from "./history.ts";
import { setLaneLimit } from "./lanes.ts";
import type { WorkflowDef, WorkflowInstance, StepResult } from "./types.ts";

const TEST_DB = `/tmp/test-orchestrator-engine-${Date.now()}.sqlite`;

function makeInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: randomUUID(),
    definitionName: "test",
    runId: randomUUID(),
    workflowId: randomUUID(),
    status: "running",
    currentStepIndex: 0,
    createdAt: Date.now(),
    finishedAt: null,
    error: null,
    parentInstanceId: null,
    ...overrides,
  };
}

function makeHandlers(results: Partial<Record<string, StepResult>> = {}): StepHandlers {
  const defaultResult: StepResult = { status: "complete", output: {} };
  return {
    "spawn-pass": async () => results["spawn-pass"] ?? defaultResult,
    "run-validation": async () => results["run-validation"] ?? defaultResult,
    "wait-signal": async () => results["wait-signal"] ?? defaultResult,
    "wait-timer": async () => results["wait-timer"] ?? defaultResult,
    "spawn-child": async () => results["spawn-child"] ?? defaultResult,
    "pause-approval": async () => results["pause-approval"] ?? defaultResult,
    "log-vault": async () => results["log-vault"] ?? defaultResult,
  };
}

describe("orchestrator engine", () => {
  beforeAll(() => {
    initDashboardDb({ enabled: true, path: TEST_DB });
  });

  afterAll(() => {
    closeDashboardDb();
  });

  beforeEach(() => {
    const db = getDashboardDb()!;
    db.exec("DELETE FROM orchestrator_instances");
    db.exec("DELETE FROM orchestrator_history");
    db.exec("DELETE FROM orchestrator_lanes");
    setLaneLimit("builder-passes", 3);
  });

  test("3-step workflow runs to completion with 3 history rows", async () => {
    const def: WorkflowDef = function* (ctx) {
      yield ctx.runValidation();
      yield ctx.spawnPass({ sequence: 0 });
      yield ctx.logToVault({ data: "done" });
    };

    const instance = makeInstance();
    upsertInstance(instance);

    const result = await executeWorkflow(def, instance, makeHandlers());

    expect(result.status).toBe("complete");

    const db = getDashboardDb()!;
    const rows = db
      .query("SELECT * FROM orchestrator_history WHERE instance_id = ? ORDER BY step_index ASC")
      .all(instance.id) as Array<{ step_index: number; kind: string }>;

    expect(rows).toHaveLength(3);
    expect(rows[0]?.kind).toBe("run-validation");
    expect(rows[1]?.kind).toBe("spawn-pass");
    expect(rows[2]?.kind).toBe("log-vault");
  });

  test("daemon restart: steps 0 and 1 are not re-executed, only step 2 runs", async () => {
    const executionOrder: number[] = [];

    const def: WorkflowDef = function* (ctx) {
      executionOrder.push(0);
      yield ctx.runValidation();
      executionOrder.push(1);
      yield ctx.spawnPass({ sequence: 0 });
      executionOrder.push(2);
      yield ctx.logToVault({ data: "done" });
    };

    // Simulate an instance that already has 2 completed steps from a prior run
    const instance = makeInstance({ currentStepIndex: 2 });
    upsertInstance(instance);

    // Insert the 2 already-executed history rows
    const h0 = appendStep(instance.id, 0, "run-validation", {});
    updateStep(h0, { status: "complete" });
    const h1 = appendStep(instance.id, 1, "spawn-pass", { sequence: 0 });
    updateStep(h1, { status: "complete" });

    executionOrder.length = 0; // reset tracking

    const handlers = makeHandlers();
    const spyLog: string[] = [];
    handlers["log-vault"] = async () => {
      spyLog.push("log-vault-called");
      return { status: "complete" };
    };

    const result = await executeWorkflow(def, instance, handlers);

    expect(result.status).toBe("complete");
    // Only step index 2 (log-vault) should have been "executed" (handler called)
    expect(spyLog).toHaveLength(1);
    // The generator advanced through indices 0 and 1 via fast-forward,
    // so executionOrder should include 0, 1, 2
    expect(executionOrder).toEqual([0, 1, 2]);
  });

  test("cancellation: step handler returns cancelled → workflow stops", async () => {
    const def: WorkflowDef = function* (ctx) {
      yield ctx.spawnPass({ sequence: 0 });
      // This step should never be reached
      yield ctx.logToVault({ data: "should-not-run" });
    };

    const instance = makeInstance();
    upsertInstance(instance);

    const cancelledResult: StepResult = { status: "cancelled", error: "user cancelled" };
    const handlers = makeHandlers({ "spawn-pass": cancelledResult });

    const logCalls: unknown[] = [];
    handlers["log-vault"] = async (payload) => {
      logCalls.push(payload);
      return { status: "complete" };
    };

    const result = await executeWorkflow(def, instance, handlers);

    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("user cancelled");
    expect(logCalls).toHaveLength(0);
  });

  test("non-deterministic yield throws OrchestratorError", async () => {
    const def: WorkflowDef = function* (_ctx) {
      // Yield a plain object without `kind` field
      yield { notAKind: true } as unknown as ReturnType<typeof _ctx.spawnPass>;
    };

    const instance = makeInstance();
    upsertInstance(instance);

    await expect(executeWorkflow(def, instance, makeHandlers())).rejects.toThrow(OrchestratorError);
  });

  test("spawn-child: parent spawns child → child completes → parent receives child result", async () => {
    // Register a simple child workflow
    const childDef: WorkflowDef = function* (ctx) {
      yield ctx.runValidation();
      yield ctx.logToVault({ data: "child-done" });
    };
    registerWorkflowDefinition("testChild", childDef);

    // Parent workflow that spawns the child
    const parentDef: WorkflowDef = function* (ctx) {
      yield ctx.runValidation();
      const result: StepResult = yield ctx.spawnChild({ definitionName: "testChild" });
      yield ctx.logToVault({ data: { childResult: result } });
    };

    const parent = makeInstance();
    upsertInstance(parent);

    const handlers = makeHandlers();
    handlers["spawn-child"] = createSpawnChildHandler(handlers);

    const result = await executeWorkflow(parentDef, parent, handlers);

    expect(result.status).toBe("complete");

    const db = getDashboardDb()!;
    const historyRows = db
      .query("SELECT * FROM orchestrator_history WHERE instance_id = ? ORDER BY step_index ASC")
      .all(parent.id) as Array<{ step_index: number; kind: string; result_json: string | null }>;

    // Parent has 3 steps: run-validation, spawn-child, log-vault
    expect(historyRows).toHaveLength(3);
    expect(historyRows[1]?.kind).toBe("spawn-child");

    const spawnChildResult = historyRows[1]?.result_json
      ? JSON.parse(historyRows[1].result_json)
      : null;
    expect(spawnChildResult?.status).toBe("complete");
    expect(spawnChildResult?.output?.childId).toBeTruthy();
    expect(spawnChildResult?.output?.childStatus).toBe("complete");

    // Verify child instance exists with parentInstanceId set
    const childInstance = getInstance(spawnChildResult.output.childId);
    expect(childInstance).not.toBeNull();
    expect(childInstance?.parentInstanceId).toBe(parent.id);
    expect(childInstance?.status).toBe("complete");
  });

  test("spawn-child: child failure propagates as blocked to parent", async () => {
    // Register a failing child workflow
    const failingChildDef: WorkflowDef = function* (ctx) {
      yield ctx.runValidation({ commands: ["exit 1"] });
    };
    registerWorkflowDefinition("failingChild", failingChildDef);

    // Parent that spawns the failing child
    const parentDef: WorkflowDef = function* (ctx) {
      yield ctx.runValidation();
      const result: StepResult = yield ctx.spawnChild({ definitionName: "failingChild" });
      yield ctx.logToVault({ data: { childResult: result } });
    };

    const parent = makeInstance();
    upsertInstance(parent);

    const handlers = makeHandlers();
    handlers["run-validation"] = async (payload) => {
      const p = payload as { commands?: string[] } | undefined;
      if (p?.commands?.includes("exit 1")) {
        return { status: "failed", error: "validation command failed" };
      }
      return { status: "complete" };
    };
    handlers["spawn-child"] = createSpawnChildHandler(handlers);

    const result = await executeWorkflow(parentDef, parent, handlers);

    // Parent should fail because child failed
    expect(result.status).toBe("failed");

    const db = getDashboardDb()!;
    const historyRows = db
      .query("SELECT * FROM orchestrator_history WHERE instance_id = ? ORDER BY step_index ASC")
      .all(parent.id) as Array<{ step_index: number; kind: string; result_json: string | null }>;

    // Only 2 steps executed: run-validation, spawn-child (then failed, so log-vault never ran)
    expect(historyRows).toHaveLength(2);
    expect(historyRows[1]?.kind).toBe("spawn-child");

    const spawnChildResult = historyRows[1]?.result_json
      ? JSON.parse(historyRows[1].result_json)
      : null;
    expect(spawnChildResult?.status).toBe("failed");
    expect(spawnChildResult?.output?.childStatus).toBe("failed");
  });
});
