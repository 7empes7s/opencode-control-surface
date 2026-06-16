import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readActionAudit } from "../db/writer.ts";
import { handleApi } from "./router.ts";
import { computeTrustScore } from "../security/score.ts";
import { isMutatingApiRequest, withAuditBoundary } from "./auditBoundary.ts";
import { issueOperatorSessionCookie } from "../auth/session.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "audit-boundary-test-"));
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

function db() {
  return getDashboardDb()!;
}

function apiReq(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  headers.set("x-tenant-id", "mimule");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

describe("isMutatingApiRequest", () => {
  test("non-mutating GET returns false", () => {
    expect(isMutatingApiRequest("GET", "/api/insights")).toBe(false);
    expect(isMutatingApiRequest("HEAD", "/api/insights")).toBe(false);
  });

  test("POST /api/auth/login and /api/auth/logout are excluded", () => {
    expect(isMutatingApiRequest("POST", "/api/auth/login")).toBe(false);
    expect(isMutatingApiRequest("POST", "/api/auth/logout")).toBe(false);
    expect(isMutatingApiRequest("POST", "/api/auth/session")).toBe(false);
  });

  test("mutating /api/internal/* are excluded", () => {
    expect(isMutatingApiRequest("POST", "/api/internal/callback")).toBe(false);
    expect(isMutatingApiRequest("DELETE", "/api/internal/anything/here")).toBe(false);
  });

  test("mutating /api/* is captured", () => {
    expect(isMutatingApiRequest("POST", "/api/insights/scan")).toBe(true);
    expect(isMutatingApiRequest("PUT", "/api/tenants/abc")).toBe(true);
    expect(isMutatingApiRequest("PATCH", "/api/projects/x")).toBe(true);
    expect(isMutatingApiRequest("DELETE", "/api/builder/workflows/y")).toBe(true);
  });

  test("non-/api paths are not captured", () => {
    expect(isMutatingApiRequest("POST", "/v1/chat/completions")).toBe(false);
    expect(isMutatingApiRequest("POST", "/login")).toBe(false);
  });
});

describe("withAuditBoundary direct call", () => {
  test("unaudited 2xx mutation writes a fallback row with actor + endpoint", async () => {
    const req = apiReq("/api/insights/scan", {
      method: "POST",
      headers: { "x-operator-token": "test-token" },
    });

    const response = await withAuditBoundary(req, "/api/insights/scan", "tester-actor", async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    expect(response.status).toBe(200);

    const fallback = readActionAudit({ actionKind: "api.unaudited-mutation" });
    expect(fallback.length).toBe(1);
    expect(fallback[0].actor).toBe("tester-actor");
    expect(fallback[0].targetId).toBe("/api/insights/scan");
    expect(fallback[0].actorSource).toBe("audit-boundary");
    expect(fallback[0].resultStatus).toBe("success");
  });

  test("400 response does NOT trigger a fallback row", async () => {
    const req = apiReq("/api/insights/scan", { method: "POST" });

    const response = await withAuditBoundary(req, "/api/insights/scan", "tester-actor", async () => {
      return new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });

    expect(response.status).toBe(400);
    const fallback = readActionAudit({ actionKind: "api.unaudited-mutation" });
    expect(fallback.length).toBe(0);
  });

  test("non-2xx 5xx does NOT trigger a fallback row", async () => {
    const req = apiReq("/api/insights/scan", { method: "POST" });

    const response = await withAuditBoundary(req, "/api/insights/scan", "tester-actor", async () => {
      return new Response(JSON.stringify({ error: "kaboom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });

    expect(response.status).toBe(500);
    expect(readActionAudit({ actionKind: "api.unaudited-mutation" }).length).toBe(0);
  });

  test("inner audit write suppresses the boundary fallback", async () => {
    const req = apiReq("/api/insights/scan", { method: "POST" });

    const response = await withAuditBoundary(req, "/api/insights/scan", "tester-actor", async () => {
      const { writeActionAudit } = await import("../db/writer.ts");
      writeActionAudit({
        actor: "tester-actor",
        actionKind: "insights.scan",
        targetType: "insights",
        targetId: "scan",
        risk: "low",
        resultStatus: "success",
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    expect(response.status).toBe(200);
    expect(readActionAudit({ actionKind: "api.unaudited-mutation" }).length).toBe(0);
    const firstClass = readActionAudit({ actionKind: "insights.scan" });
    expect(firstClass.length).toBe(1);
  });
});

describe("router dispatch + audit boundary integration", () => {
  test("POST /api/insights/scan (mutating, audited) → exactly the first-class audit row, no fallback", async () => {
    const now = Date.now();
    db().query(`
      INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
      VALUES ('owner-audit', 'audit-owner@example.test', 'Audit Owner', 'local', ?, 'mimule')
    `).run(now);
    db().query(`
      INSERT INTO governance_role_bindings (id, user_id, role, created_at, tenant_id)
      VALUES ('rb-audit-owner', 'owner-audit', 'owner', ?, 'mimule')
    `).run(now);

    const req = apiReq("/api/insights/scan", {
      method: "POST",
      headers: {
        "x-operator-token": "test-token",
        cookie: issueOperatorSessionCookie("owner-audit", "mimule"),
      },
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);

    const fallback = readActionAudit({ actionKind: "api.unaudited-mutation" });
    expect(fallback.length).toBe(0);
  });
});

describe("Trust Score sees boundary fallbacks", () => {
  test("seeded api.unaudited-mutation row → actions-attributed unearned with endpoint named", () => {
    const baseScore = computeTrustScore();
    const baseCheck = baseScore.checks.find((c) => c.id === "actions-attributed")!;
    expect(baseCheck.earned).toBe(true);

    const now = Date.now();
    db().query(`
      INSERT INTO action_audit
        (ts, actor, actor_source, action_kind, action, target_type, target_id, risk, result_status, tenant_id)
      VALUES (?, 'someone', 'audit-boundary', 'api.unaudited-mutation', 'api.unaudited-mutation', 'endpoint', '/api/example/missing-audit', 'low', 'success', 'mimule')
    `).run(now);

    const nextScore = computeTrustScore();
    const nextCheck = nextScore.checks.find((c) => c.id === "actions-attributed")!;
    expect(nextCheck.earned).toBe(false);
    expect(nextCheck.plainSummary).toContain("/api/example/missing-audit");
    expect(nextCheck.plainSummary.toLowerCase()).toContain("first-class");
  });
});
