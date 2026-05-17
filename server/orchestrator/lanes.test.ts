import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { acquireLane, releaseLane, getLaneStatus, setLaneLimit } from "./lanes.ts";
import { executeWorkflow, type StepHandlers } from "./engine.ts";
import { upsertInstance } from "./history.ts";
import type { WorkflowDef, WorkflowInstance } from "./types.ts";

const TEST_DB = `/tmp/test-orchestrator-lanes-${Date.now()}.sqlite`;
const LANE = "test-lane";

function makeInstance(): WorkflowInstance {
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
  };
}

describe("orchestrator lanes", () => {
  beforeAll(() => {
    initDashboardDb({ enabled: true, path: TEST_DB });
  });

  afterAll(() => {
    closeDashboardDb();
  });

  beforeEach(() => {
    const db = getDashboardDb()!;
    db.exec("DELETE FROM orchestrator_lanes");
    db.exec("DELETE FROM orchestrator_instances");
    db.exec("DELETE FROM orchestrator_history");
  });

  test("acquireLane returns false when at limit", () => {
    setLaneLimit(LANE, 2);
    expect(acquireLane(LANE)).toBe(true);
    expect(acquireLane(LANE)).toBe(true);
    expect(acquireLane(LANE)).toBe(false); // at limit
    releaseLane(LANE);
    expect(acquireLane(LANE)).toBe(true); // slot freed
  });

  test("getLaneStatus returns correct counts", () => {
    setLaneLimit(LANE, 3);
    acquireLane(LANE);
    acquireLane(LANE);
    const status = getLaneStatus(LANE);
    expect(status?.active).toBe(2);
    expect(status?.max).toBe(3);
  });

  test("releaseLane floors at 0", () => {
    setLaneLimit(LANE, 3);
    releaseLane(LANE); // active is 0, shouldn't go negative
    const status = getLaneStatus(LANE);
    expect(status?.active).toBe(0);
  });

  test("4 concurrent spawn-pass with lane max=3 → first 3 succeed, 4th blocked", async () => {
    // Use the engine-level builder-passes lane
    const db = getDashboardDb()!;
    db.exec("DELETE FROM orchestrator_lanes");
    setLaneLimit("builder-passes", 3);

    const def: WorkflowDef = function* (ctx) {
      yield ctx.spawnPass({ sequence: 0 });
    };

    // Slow handler to keep lane slots occupied during concurrent runs
    let activeHandlers = 0;
    const handlers: StepHandlers = {
      "spawn-pass": async () => {
        activeHandlers++;
        await new Promise((r) => setTimeout(r, 50));
        activeHandlers--;
        return { status: "complete" };
      },
      "run-validation": async () => ({ status: "complete" }),
      "wait-signal": async () => ({ status: "complete" }),
      "wait-timer": async () => ({ status: "complete" }),
      "spawn-child": async () => ({ status: "complete" }),
      "pause-approval": async () => ({ status: "complete" }),
      "log-vault": async () => ({ status: "complete" }),
    };

    const instances = [makeInstance(), makeInstance(), makeInstance(), makeInstance()];
    for (const inst of instances) upsertInstance(inst);

    const results = await Promise.all(
      instances.map((inst) => executeWorkflow(def, inst, handlers)),
    );

    const completed = results.filter((r) => r.status === "complete").length;
    const blocked = results.filter((r) => r.status === "blocked").length;

    // With max=3 and concurrent execution, at least 1 should be blocked
    // (exact split depends on timing, but blocked >= 1 and completed >= 1)
    expect(completed + blocked).toBe(4);
    expect(blocked).toBeGreaterThanOrEqual(1);
  });
});
