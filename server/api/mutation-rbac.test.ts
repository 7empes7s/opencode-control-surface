import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { issueOperatorSessionCookie } from "../auth/session.ts";
import { handleApi } from "./router.ts";
import type { RbacRole } from "../governance/rbac.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevSessionSecret: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "mutation-rbac-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevSessionSecret = process.env.OPERATOR_SESSION_SECRET;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.OPERATOR_SESSION_SECRET = "mutation-rbac-test-secret";
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
  if (prevSessionSecret === undefined) delete process.env.OPERATOR_SESSION_SECRET;
  else process.env.OPERATOR_SESSION_SECRET = prevSessionSecret;
  rmSync(tempDir, { recursive: true, force: true });
});

function seedUser(userId: string, role: RbacRole): void {
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

function authedRequest(userId: string, path: string, init: RequestInit): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: issueOperatorSessionCookie(userId, "mimule"),
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

describe("router mutation RBAC", () => {
  test("viewer cannot reach builder mutation handlers", async () => {
    seedUser("viewer-user", "viewer");
    const req = authedRequest("viewer-user", "/api/builder/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "Blocked", projectRoot: "/tmp", planFile: "plan.md" }),
    });

    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("Your role cannot make this change.");
  });

  test("operator passes the builder mutation gate", async () => {
    seedUser("operator-user", "operator");
    const req = authedRequest("operator-user", "/api/builder/workflows/missing-workflow", {
      method: "PUT",
      body: JSON.stringify({ name: "Allowed", projectRoot: "/tmp", planFile: "plan.md" }),
    });

    const res = await handleApi(req, new URL(req.url));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    const body = await res.json() as { error?: string };
    expect(body.error).not.toBe("Your role cannot make this change.");
  });
});
