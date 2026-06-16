import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { handleApi } from "../api/router.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "security-api-test-"));
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
  headers.set("x-tenant-id", "mimule");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

describe("Security Posture API", () => {
  test("Unauthorized request returns 401", async () => {
    const req = apiReq("/api/security/posture");
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(401);
  });

  test("Authorized request with empty DB returns posture 'good'", async () => {
    const req = apiReq("/api/security/posture", {
      headers: { "x-operator-token": "test-token" },
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.posture).toBe("good");
    expect(body.data.openCount).toBe(0);
    expect(body.data.checksRun).toBe(5);
    expect(body.data.findings).toBeArray();
  });

  test("Seeded at-risk condition returns posture 'at-risk'", async () => {
    const now = Date.now();
    // Seed agent workflow without budget cap
    db().query(`
      INSERT INTO builder_workflows
        (id, project_id, name, mode, status, plan_file, config_json, created_at, updated_at, tenant_id)
      VALUES ('wf-active-test', 'project-1', 'Active workflow', 'permanent', 'active', 'plan.md', '{}', ?, ?, 'mimule')
    `).run(now, now);

    const req = apiReq("/api/security/posture", {
      headers: { "x-operator-token": "test-token" },
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json();
    
    expect(body.data.posture).toBe("at-risk"); // high finding makes it at-risk
    const finding = body.data.findings.find((f: any) => f.id === "insight_security_agents_without_budget_cap");
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("high");
    expect(finding.actionDescriptorId).toBe("mutate-policy:budget:global:set-cap");
  });
});
