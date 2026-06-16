import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { checkPermission, resolveRole, getAllowedActions, getRoleForRequest, type RbacRole } from "./rbac.ts";
import { issueOperatorSessionCookie } from "../auth/session.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevNodeEnv: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "rbac-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevNodeEnv = process.env.NODE_ENV;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.NODE_ENV = "development";
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
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  rmSync(tempDir, { recursive: true, force: true });
});

function seedUser(userId: string, role?: RbacRole, tenantId = "mimule"): void {
  const db = getDashboardDb()!;
  db.query(
    `INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, `${userId}@example.test`, userId, "local", Date.now(), tenantId);
  if (role) {
    db.query(
      `INSERT INTO governance_role_bindings (id, user_id, role, tenant_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(`binding-${userId}`, userId, role, tenantId, Date.now());
  }
}

function sessionReq(userId: string, tenantId = "mimule"): Request {
  return new Request("http://localhost/api/governance/rbac/me", {
    headers: { cookie: issueOperatorSessionCookie(userId, tenantId) },
  });
}

describe("resolveRole", () => {
  test("looks up the authenticated user's binding", () => {
    seedUser("u-owner", "owner");
    const role = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => getRoleForRequest(sessionReq("u-owner")));
    expect(role).toBe("owner");
  });

  test("missing binding maps to viewer", () => {
    seedUser("u-unbound");
    const role = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => getRoleForRequest(sessionReq("u-unbound")));
    expect(role).toBe("viewer");
  });

  test("local operator token remains bootstrap owner", () => {
    const role = resolveRole("test-token");
    expect(role).toBe("owner");
  });

});

describe("checkPermission", () => {
  const actions: [RbacRole, string, boolean][] = [
    // owner can do everything
    ["owner", "workflow.start", true],
    ["owner", "workflow.stop", true],
    ["owner", "secrets.read", true],
    ["owner", "secrets.write", true],
    ["owner", "audit.view", true],
    ["owner", "gateway.call", true],
    // operator
    ["operator", "workflow.start", true],
    ["operator", "workflow.stop", true],
    ["operator", "secrets.read", true],
    ["operator", "secrets.write", true],
    ["operator", "audit.view", true],
    ["operator", "gateway.call", true],
    ["operator", "audit.write", true],
    // auditor
    ["auditor", "audit.view", true],
    ["auditor", "audit.write", false],
    ["auditor", "workflow.start", false],
    ["auditor", "secrets.read", false],
    // viewer
    ["viewer", "audit.view", true],
    ["viewer", "workflow.view", true],
    ["viewer", "workflow.start", false],
    ["viewer", "secrets.read", false],
    ["viewer", "secrets.write", false],
    ["viewer", "audit.write", false],
  ];

  for (const [role, action, expected] of actions) {
    test(`${role} / ${action} → ${expected}`, () => {
      expect(checkPermission(role, action)).toBe(expected);
    });
  }
});

describe("getAllowedActions", () => {
  test("owner gets wildcard", () => {
    const perms = getAllowedActions("owner");
    expect(perms).toContain("*");
  });

  test("viewer gets limited actions", () => {
    const perms = getAllowedActions("viewer");
    expect(perms).toContain("audit.view");
    expect(perms).not.toContain("secrets.write");
  });
});
