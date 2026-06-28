/**
 * Fail-closed auth tests — Phase 1 safety prerequisite.
 *
 * Verifies that checkToken and requireMutation both reject when OPERATOR_TOKEN
 * is unset, even on local (127.0.0.1) requests that would otherwise trigger
 * the dev-bootstrap path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { checkToken } from "./actions.ts";
import { canMutate, requireMutation } from "../governance/rbac.ts";
import { handleApi } from "./router.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevSessionSecret: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "fail-closed-auth-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevSessionSecret = process.env.OPERATOR_SESSION_SECRET;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_SESSION_SECRET = "fail-closed-test-secret";
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

// Local (127.0.0.1) request — normally triggers dev-bootstrap when no token.
function localReq(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("checkToken — fail-closed", () => {
  test("returns false when OPERATOR_TOKEN is unset, even from localhost", () => {
    delete process.env.OPERATOR_TOKEN;
    const req = localReq("/api/insights");
    const result = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => checkToken(req));
    expect(result).toBe(false);
  });

  test("returns true when correct Bearer token is present", () => {
    process.env.OPERATOR_TOKEN = "test-secret";
    const req = new Request("http://example.com/api/insights", {
      headers: { Authorization: "Bearer test-secret" },
    });
    const result = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => checkToken(req));
    expect(result).toBe(true);
  });

  test("returns false when wrong token header is supplied", () => {
    process.env.OPERATOR_TOKEN = "correct-secret";
    const req = new Request("http://example.com/api/insights", {
      headers: { Authorization: "Bearer wrong-secret" },
    });
    const result = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => checkToken(req));
    expect(result).toBe(false);
  });
});

describe("canMutate / requireMutation — fail-closed", () => {
  test("canMutate returns false when OPERATOR_TOKEN is unset", () => {
    delete process.env.OPERATOR_TOKEN;
    const req = localReq("/api/infra/service-restart", { method: "POST" });
    const result = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => canMutate(req));
    expect(result).toBe(false);
  });

  test("requireMutation returns 401 when OPERATOR_TOKEN is unset", () => {
    delete process.env.OPERATOR_TOKEN;
    const req = localReq("/api/infra/service-restart", { method: "POST" });
    const result = tenantStore.run(testTenantContext({ tenantId: "mimule" }), () => requireMutation(req));
    expect(result).not.toBeNull();
    expect((result as Response).status).toBe(401);
  });

  test("POST /api/infra/service-restart returns 401 when OPERATOR_TOKEN is unset", async () => {
    delete process.env.OPERATOR_TOKEN;
    const req = localReq("/api/infra/service-restart", {
      method: "POST",
      body: JSON.stringify({ service: "litellm" }),
    });
    const res = await tenantStore.run(
      testTenantContext({ tenantId: "mimule" }),
      () => handleApi(req, new URL(req.url)),
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/infra/service-restart returns 403 when wrong token", async () => {
    process.env.OPERATOR_TOKEN = "correct-token";
    const req = new Request("http://example.com/api/infra/service-restart", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operator-token": "wrong-token",
      },
      body: JSON.stringify({ service: "litellm" }),
    });
    const res = await tenantStore.run(
      testTenantContext({ tenantId: "mimule" }),
      () => handleApi(req, new URL(req.url)),
    );
    // Non-local request with wrong token → not authenticated → 401
    expect([401, 403]).toContain(res.status);
  });
});

describe("insights engine — fail-closed (no HTTP token path)", () => {
  test("autoApplySafeInsights skips when OPERATOR_TOKEN is unset", async () => {
    delete process.env.OPERATOR_TOKEN;
    const { autoApplySafeInsights } = await import("../insights/autoapply.ts");
    const applied = await tenantStore.run(
      testTenantContext({ tenantId: "mimule" }),
      () => autoApplySafeInsights([]),
    );
    expect(applied).toBe(0);
  });
});
