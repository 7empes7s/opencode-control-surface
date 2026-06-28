/**
 * Jobs cancel/retry — Phase 1 durable-jobs test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDashboardDb,
  getDashboardDb,
  initDashboardDb,
} from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  createJob,
  finishJob,
  readJob,
  requestJobCancel,
  retryJob,
} from "../db/writer.ts";
import { handleApi } from "./router.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "jobs-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  rmSync(tempDir, { recursive: true, force: true });
});

function ownerReq(path: string, init: RequestInit = {}): Request {
  // Use x-operator-token (operator-bootstrap path). No session cookie needed —
  // bootstrapOwnerAllowed returns true in non-production tests.
  return new Request(`http://127.0.0.1:3000${path}`, {
    headers: {
      "content-type": "application/json",
      "x-operator-token": "test-token",
    },
    ...init,
  });
}

function seedRunningJob(): string {
  const id = crypto.randomUUID();
  tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
    createJob({
      id,
      kind: "test-job",
      targetType: "test",
      targetId: "thing",
      command: "echo hello",
    })
  );
  return id;
}

describe("requestJobCancel", () => {
  test("marks a running job as canceled", () => {
    const id = seedRunningJob();
    const ok = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      requestJobCancel(id)
    );
    expect(ok).toBe(true);
    const job = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      readJob(id)
    );
    expect(job?.status).toBe("canceled");
    expect(job?.finishedAt).toBeGreaterThan(0);
  });

  test("returns false for a non-running job", () => {
    const id = seedRunningJob();
    tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      finishJob(id, "success", { output: "done" })
    );
    const ok = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      requestJobCancel(id)
    );
    expect(ok).toBe(false);
  });
});

describe("retryJob", () => {
  test("creates a child job from a failed parent", () => {
    const parentId = seedRunningJob();
    tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      finishJob(parentId, "failed", { error: "oh no", exitCode: 1 })
    );
    const childId = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      retryJob(parentId)
    );
    expect(childId).toBeString();

    const parent = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      readJob(parentId)
    );
    expect(parent?.retryCount).toBe(1);

    const child = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      readJob(childId!)
    );
    expect(child?.kind).toBe("test-job");
    expect(child?.status).toBe("running");
    expect(child?.retryOfJobId).toBe(parentId);
  });

  test("returns null for a still-running job", () => {
    const id = seedRunningJob();
    const childId = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      retryJob(id)
    );
    expect(childId).toBeNull();
  });

  test("returns null when retry limit reached", () => {
    const id = seedRunningJob();
    tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => {
      finishJob(id, "failed", { error: "nope" });
      const db = getDashboardDb()!;
      db.query("UPDATE jobs SET retry_count = max_retries WHERE id = ?").run(id);
    });
    const childId = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      retryJob(id)
    );
    expect(childId).toBeNull();
  });
});

describe("POST /api/jobs/:id/cancel", () => {
  test("returns 200 and cancels a running job via API", async () => {
    const id = seedRunningJob();
    const req = ownerReq(`/api/jobs/${id}/cancel`, { method: "POST" });
    const res = await tenantStore.run(
      testTenantContext({ tenantId: "mimule" }),
      () => handleApi(req, new URL(req.url))
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("returns 401 without token", async () => {
    const id = seedRunningJob();
    const req = new Request(`http://example.com/api/jobs/${id}/cancel`, { method: "POST" });
    const res = await tenantStore.run(
      testTenantContext({ tenantId: "mimule" }),
      () => handleApi(req, new URL(req.url))
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/jobs/:id/retry", () => {
  test("returns 200 and creates a child job via API", async () => {
    const parentId = seedRunningJob();
    tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
      finishJob(parentId, "failed", { error: "nope" })
    );
    const req = ownerReq(`/api/jobs/${parentId}/retry`, { method: "POST" });
    const res = await tenantStore.run(
      testTenantContext({ tenantId: "mimule" }),
      () => handleApi(req, new URL(req.url))
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; childJobId: string };
    expect(body.ok).toBe(true);
    expect(body.childJobId).toBeString();
  });
});
