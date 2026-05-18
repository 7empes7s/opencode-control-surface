import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { createApprovalRequest } from "../governance/approvals.ts";
import { writeSecret } from "../governance/secrets.ts";
import { upsertBudget } from "../governance/budgets.ts";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";

function withTenant<R>(tenantId: string, fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

function authedReq(method = "GET", body?: unknown): Request {
  return new Request("http://localhost/api/governance/approvals", {
    method,
    headers: { "x-operator-token": "test-token", "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "governance-api-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
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

describe("governance API tenant isolation", () => {
  test("approvals list only returns current tenant requests", async () => {
    const { governanceApprovalsListHandler } = await import("./governance.ts");

    withTenant("tenant-a", () => {
      createApprovalRequest("wf-a", "run-a", "alice", 1);
    });
    withTenant("tenant-b", () => {
      createApprovalRequest("wf-b", "run-b", "bob", 1);
    });

    const resA = await withTenant("tenant-a", () => governanceApprovalsListHandler(authedReq()));
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { pending: Array<{ workflow_id: string }> };
    expect(bodyA.pending.length).toBe(1);
    expect(bodyA.pending[0].workflow_id).toBe("wf-a");

    const resB = await withTenant("tenant-b", () => governanceApprovalsListHandler(authedReq()));
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { pending: Array<{ workflow_id: string }> };
    expect(bodyB.pending.length).toBe(1);
    expect(bodyB.pending[0].workflow_id).toBe("wf-b");
  });

  test("secrets list only returns current tenant secrets", async () => {
    const { governanceSecretsListHandler } = await import("./governance.ts");

    withTenant("tenant-a", () => {
      writeSecret("key-a", "val-a", "desc-a");
    });
    withTenant("tenant-b", () => {
      writeSecret("key-b", "val-b", "desc-b");
    });

    const resA = await withTenant("tenant-a", () => governanceSecretsListHandler(authedReq()));
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { secrets: Array<{ name: string }> };
    expect(bodyA.secrets.length).toBe(1);
    expect(bodyA.secrets[0].name).toBe("key-a");

    const resB = await withTenant("tenant-b", () => governanceSecretsListHandler(authedReq()));
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { secrets: Array<{ name: string }> };
    expect(bodyB.secrets.length).toBe(1);
    expect(bodyB.secrets[0].name).toBe("key-b");
  });

  test("budgets list only returns current tenant budgets", async () => {
    const { governanceBudgetsListHandler } = await import("./governance.ts");

    withTenant("tenant-a", () => {
      upsertBudget("global", { dailyCapUsd: 100, monthlyCapUsd: 1000 });
    });
    withTenant("tenant-b", () => {
      upsertBudget("global", { dailyCapUsd: 200, monthlyCapUsd: 2000 });
    });

    const resA = await withTenant("tenant-a", () => governanceBudgetsListHandler(authedReq()));
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { budgets: Array<{ tenant_id: string }> };
    expect(bodyA.budgets.length).toBe(1);
    expect(bodyA.budgets[0].tenant_id).toBe("tenant-a");

    const resB = await withTenant("tenant-b", () => governanceBudgetsListHandler(authedReq()));
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { budgets: Array<{ tenant_id: string }> };
    expect(bodyB.budgets.length).toBe(1);
    expect(bodyB.budgets[0].tenant_id).toBe("tenant-b");
  });
});
