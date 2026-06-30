import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { createApprovalRequest } from "../governance/approvals.ts";
import { writeSecret } from "../governance/secrets.ts";
import { upsertBudget } from "../governance/budgets.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { authStore, issueOperatorSessionCookie } from "../auth/session.ts";
import { readActionAudit } from "../db/writer.ts";

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

function sessionReq(userId: string, url: string, body?: unknown, method = "GET"): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: issueOperatorSessionCookie(userId, "mimule"),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function seedUser(userId: string, role?: string): void {
  const db = getDashboardDb()!;
  db.query(
    `INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, `${userId}@example.test`, `User ${userId}`, "local", Date.now(), "mimule");
  db.query(
    `INSERT OR REPLACE INTO local_account_credentials (user_id, password_hash, updated_at)
     VALUES (?, ?, ?)`,
  ).run(userId, `hash-${userId}`, Date.now());
  if (role) {
    db.query(
      `INSERT INTO governance_role_bindings (id, user_id, role, tenant_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(`binding-${userId}`, userId, role, "mimule", Date.now());
  }
}

async function withAuth(userId: string, fn: () => Promise<Response>): Promise<Response> {
  return tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
    authStore.run({ userId, tenantId: "mimule", source: "local" }, fn),
  );
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

describe("governance users and RBAC matrix API", () => {
  test("user directory returns users with roles and excludes credential fields", async () => {
    const { governanceUsersHandler } = await import("./governance.ts");
    seedUser("owner", "owner");
    seedUser("auditor", "auditor");

    const res = await withAuth("owner", () => governanceUsersHandler(sessionReq("owner", "http://localhost/api/governance/users")));
    expect(res.status).toBe(200);
    const body = await res.json() as { users: Array<Record<string, unknown>> };
    expect(body.users.length).toBe(2);
    expect(body.users.find((user) => user.id === "auditor")?.role).toBe("auditor");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("hash-auditor");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("secret");
    expect(body.users[0]).not.toHaveProperty("auth_method");
  });

  test("RBAC matrix returns the four real roles and actions", async () => {
    const { rbacMatrixHandler } = await import("./governance.ts");
    seedUser("viewer", "viewer");

    const res = await withAuth("viewer", () => rbacMatrixHandler(sessionReq("viewer", "http://localhost/api/rbac/matrix")));
    expect(res.status).toBe(200);
    const body = await res.json() as { matrix: Record<string, string[]>; roles: string[] };
    expect(body.roles.sort()).toEqual(["auditor", "operator", "owner", "viewer"]);
    expect(body.matrix.owner).toEqual(["*"]);
    expect(body.matrix.operator).toContain("insights.apply");
    expect(body.matrix.viewer).toContain("audit.view");
  });

  test("owner can set a role and the change persists with audit", async () => {
    const { governanceUserRoleHandler } = await import("./governance.ts");
    seedUser("owner", "owner");
    seedUser("target", "viewer");

    const req = sessionReq("owner", "http://localhost/api/governance/users/target/role", { role: "operator" }, "POST");
    const res = await withAuth("owner", () => governanceUserRoleHandler(req, "target"));
    expect(res.status).toBe(200);
    const db = getDashboardDb()!;
    const row = db.query("SELECT role FROM governance_role_bindings WHERE user_id = ? AND tenant_id = ?").get("target", "mimule") as { role: string };
    expect(row.role).toBe("operator");
    const audit = readActionAudit({ actionKind: "governance.set-role" });
    expect(audit[0].userId).toBe("owner");
    expect(audit[0].targetId).toBe("target");
  });

  test("non-owner cannot set roles", async () => {
    const { governanceUserRoleHandler } = await import("./governance.ts");
    seedUser("operator", "operator");
    seedUser("target", "viewer");

    const req = sessionReq("operator", "http://localhost/api/governance/users/target/role", { role: "auditor" }, "POST");
    const res = await withAuth("operator", () => governanceUserRoleHandler(req, "target"));
    expect(res.status).toBe(403);
  });

  test("missing session cannot set roles", async () => {
    const { governanceUserRoleHandler } = await import("./governance.ts");
    seedUser("owner", "owner");
    seedUser("target", "viewer");

    const req = new Request("http://localhost/api/governance/users/target/role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "auditor" }),
    });
    const res = await governanceUserRoleHandler(req, "target");
    expect(res.status).toBe(401);
  });

  test("demoting the last owner is refused", async () => {
    const { governanceUserRoleHandler } = await import("./governance.ts");
    seedUser("owner", "owner");

    const req = sessionReq("owner", "http://localhost/api/governance/users/owner/role", { role: "operator" }, "POST");
    const res = await withAuth("owner", () => governanceUserRoleHandler(req, "owner"));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("last owner");
  });
});
