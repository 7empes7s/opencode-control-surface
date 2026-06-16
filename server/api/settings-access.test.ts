import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { authStore, issueOperatorSessionCookie } from "../auth/session.ts";
import { settingsAccessInviteHandler, settingsAccessRoleHandler } from "./settings.ts";
import { readActionAudit } from "../db/writer.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "settings-access-test-"));
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

function seedUser(userId: string, role: string): void {
  const db = getDashboardDb()!;
  db.query(
    `INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, `${userId}@example.test`, userId, "local", Date.now(), "mimule");
  db.query(
    `INSERT INTO governance_role_bindings (id, user_id, role, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`binding-${userId}`, userId, role, "mimule", Date.now());
}

function reqFor(userId: string, url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: issueOperatorSessionCookie(userId, "mimule"),
    },
    body: JSON.stringify(body),
  });
}

async function withTenantAndAuth(userId: string, fn: () => Promise<Response>): Promise<Response> {
  return tenantStore.run(testTenantContext({ tenantId: "mimule" }), () =>
    authStore.run({ userId, tenantId: "mimule", source: "local" }, fn),
  );
}

describe("settings access management", () => {
  test("owner can invite a user and the audit row has user_id", async () => {
    seedUser("owner", "owner");
    const req = reqFor("owner", "http://localhost/api/settings/access/invite", {
      email: "new-user@example.test",
      name: "New User",
      password: "long-enough-password",
      role: "auditor",
    });
    const res = await withTenantAndAuth("owner", () => settingsAccessInviteHandler(req));
    expect(res.status).toBe(201);

    const db = getDashboardDb()!;
    const user = db.query("SELECT id FROM users WHERE email = ?").get("new-user@example.test") as { id: string } | null;
    expect(user?.id).toBeTruthy();
    const binding = db.query("SELECT role FROM governance_role_bindings WHERE user_id = ?").get(user!.id) as { role: string };
    expect(binding.role).toBe("auditor");

    const audit = readActionAudit({ actionKind: "access.invite" });
    expect(audit[0].userId).toBe("owner");
  });

  test("viewer cannot change roles", async () => {
    seedUser("viewer", "viewer");
    seedUser("target", "auditor");
    const req = reqFor("viewer", "http://localhost/api/settings/access/users/target/role", { role: "owner" }, "PUT");
    const res = await withTenantAndAuth("viewer", () => settingsAccessRoleHandler(req, "target"));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Only an owner can make this change.");
  });
});
