import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { authLoginHandler } from "./auth.ts";
import { getAuthenticatedUser } from "../auth/session.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "auth-api-test-"));
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

async function seedLocalUser(): Promise<void> {
  const db = getDashboardDb()!;
  db.query(
    `INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("u-login", "login@example.test", "Login User", "local", Date.now(), "mimule");
  db.query(
    `INSERT INTO local_account_credentials (user_id, password_hash, updated_at)
     VALUES (?, ?, ?)`,
  ).run("u-login", await Bun.password.hash("correct-password", "argon2id"), Date.now());
}

function loginReq(password: string): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "login@example.test", password }),
  });
}

describe("local account login", () => {
  test("sets operator_session with a real user id", async () => {
    await seedLocalUser();
    const res = await tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => authLoginHandler(loginReq("correct-password")));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("operator_session=");

    const authedReq = new Request("http://localhost/api/governance/rbac/me", {
      headers: { cookie },
    });
    const user = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => getAuthenticatedUser(authedReq));
    expect(user?.userId).toBe("u-login");
  });

  test("bad credentials return a plain English error", async () => {
    await seedLocalUser();
    const res = await tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => authLoginHandler(loginReq("wrong-password")));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Email or password is incorrect.");
  });
});
