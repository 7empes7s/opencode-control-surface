import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { queueDiagnosis } from "./agent.ts";

let mockCompleteCalls: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
let mockCompleteResponses: Array<{ choices: Array<{ message: { content: string } }> }> = [];

function setupMockComplete() {
  mockCompleteCalls = [];
  mockCompleteResponses = [];
}

function mockCompleteFn(model: string, messages: Array<{ role: string; content: string }>) {
  mockCompleteCalls.push({ model, messages });
  if (mockCompleteResponses.length === 0) {
    throw new Error("no mock response configured");
  }
  return Promise.resolve(mockCompleteResponses.shift()!);
}

describe("reasoner agent", () => {
  const testDbPath = `/tmp/test-reasoner-${Date.now()}.sqlite`;

  beforeAll(() => {
    initDashboardDb({ enabled: true, path: testDbPath });
  });

  afterAll(() => {
    closeDashboardDb();
  });

  beforeEach(() => {
    mockCompleteCalls = [];
    mockCompleteResponses = [];
  });

  test("queueDiagnosis inserts a pending job row", () => {
    const db = getDashboardDb()!;
    db.query("DELETE FROM reasoner_jobs").run();

    const jobId = queueDiagnosis("pass-abc", "run-xyz", "wf-123");

    expect(jobId.startsWith("rq_")).toBe(true);
    const row = db.query("SELECT * FROM reasoner_jobs WHERE id = ?").get(jobId) as {
      id: string;
      pass_id: string;
      run_id: string;
      workflow_id: string;
      status: string;
      attempts: number;
      created_at: number;
    } | null;
    expect(row).not.toBeNull();
    expect(row!.pass_id).toBe("pass-abc");
    expect(row!.run_id).toBe("run-xyz");
    expect(row!.workflow_id).toBe("wf-123");
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
  });

  test("queueDiagnosis generates unique IDs", () => {
    const db = getDashboardDb()!;
    db.query("DELETE FROM reasoner_jobs").run();

    const id1 = queueDiagnosis("p1", "r1", "w1");
    const id2 = queueDiagnosis("p2", "r2", "w2");

    expect(id1).not.toBe(id2);
  });
});