import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import {
  getAgent,
  getAgentPassport,
  listAgents,
  seedDefaultAgents,
} from "./registry.ts";
import { handleApi } from "../api/router.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "agent-registry-test-"));
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

function apiReq(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  headers.set("x-tenant-id", "mimule");
  if (!headers.has("x-operator-token")) headers.set("x-operator-token", "test-token");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

describe("agent registry seed", () => {
  test("seedDefaultAgents is idempotent and seeds exactly 7 agents", () => {
    const first = seedDefaultAgents();
    expect(first).toBe(7);
    const second = seedDefaultAgents();
    expect(second).toBe(0);

    const rows = db().query("SELECT id FROM agents ORDER BY id").all() as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual([
      "autopipeline",
      "codex-runner",
      "gemini-runner",
      "insights-scanner",
      "opencode-runner",
      "product-sentinel",
      "reasoner",
    ]);
  });
});

describe("agent registry list", () => {
  test("listAgents enriches reasoner with lastSeenAt and audit7d from action_audit", () => {
    seedDefaultAgents();
    const now = Date.now();
    db().query(`
      INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status)
      VALUES (?, 'reasoner', 'system', 'reasoner.diagnose', 'reasoner.diagnose', 'pass', 'pass-1', 'success')
    `).run(now - 1000);

    const agents = listAgents();
    const reasoner = agents.find((a) => a.id === "reasoner");
    expect(reasoner).toBeDefined();
    expect(reasoner!.aliases).toContain("reasoner");
    expect(reasoner!.lastSeenAt).toBe(now - 1000);
    expect(reasoner!.audit7d).toBeGreaterThanOrEqual(1);

    const getReasoner = getAgent("reasoner");
    expect(getReasoner?.lastSeenAt).toBe(now - 1000);
    expect(getReasoner?.audit7d).toBeGreaterThanOrEqual(1);
  });
});

describe("agent registry passport", () => {
  test("getAgentPassport returns the audit row for the reasoner agent", () => {
    seedDefaultAgents();
    const now = Date.now();
    db().query(`
      INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, reason)
      VALUES (?, 'reasoner', 'system', 'reasoner.diagnose', 'reasoner.diagnose', 'pass', 'pass-99', 'success', 'diagnosed')
    `).run(now);

    const passport = getAgentPassport("reasoner");
    expect(passport).not.toBeNull();
    expect(passport!.agent.id).toBe("reasoner");
    expect(passport!.agent.audit7d).toBeGreaterThanOrEqual(1);
    expect(passport!.recentAudit.some((row) => row.targetId === "pass-99" && row.reason === "diagnosed")).toBe(true);
    expect(passport!.gateway.calls30d).toBe(0);
    expect(passport!.gateway.spend30dUsd).toBe(0);
  });

  test("getAgentPassport matches gateway_calls by agent id (not just alias) and sets lastSeenAt", () => {
    seedDefaultAgents();
    const now = Date.now();
    // Insert an action_audit row keyed by agent id (not alias "opencode")
    db().query(`
      INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status)
      VALUES (?, 'opencode-runner', 'system', 'coding.edit', 'coding.edit', 'file', 'src/app.ts', 'success')
    `).run(now - 2000);
    // Insert a gateway_calls row keyed by agent id (not alias "opencode")
    db().query(`
      INSERT INTO gateway_calls (ts, caller, logical_model, resolved_model, backend, tier, cost_estimate_usd)
      VALUES (?, 'opencode-runner', 'minimax-m3', 'minimax-m3', 'local', 'heavy', 0.012)
    `).run(now - 1000);

    const passport = getAgentPassport("opencode-runner");
    expect(passport).not.toBeNull();
    expect(passport!.agent.id).toBe("opencode-runner");
    expect(passport!.agent.lastSeenAt).toBe(now - 2000);
    expect(passport!.agent.audit7d).toBeGreaterThanOrEqual(1);
    expect(passport!.gateway.calls30d).toBe(1);
    expect(passport!.gateway.spend30dUsd).toBeCloseTo(0.012, 6);
    expect(passport!.recentAudit.some((row) => row.targetId === "src/app.ts")).toBe(true);
  });

  test("getAgentPassport returns null for an unknown agent id", () => {
    seedDefaultAgents();
    expect(getAgentPassport("does-not-exist")).toBeNull();
  });
});

describe("agent registry API handlers", () => {
  test("GET /api/agent-registry returns 401 when unauthenticated", async () => {
    const req = new Request("http://localhost/api/agent-registry", {
      headers: { "x-tenant-id": "mimule" },
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(401);
  });

  test("GET /api/agent-registry returns 7 agents with counts when authorized", async () => {
    const res = await handleApi(apiReq("/api/agent-registry"), new URL("http://localhost/api/agent-registry"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: { agents?: Array<{ id: string; status: string }>; counts?: { total: number; active: number; paused: number; retired: number } } };
    expect(body.data?.agents).toBeDefined();
    expect(body.data!.agents!.length).toBe(7);
    expect(body.data!.counts).toEqual({ total: 7, active: 6, paused: 1, retired: 0 });
  });

  test("GET /api/agent-registry/:id returns passport for an authorized request", async () => {
    const res = await handleApi(apiReq("/api/agent-registry/reasoner"), new URL("http://localhost/api/agent-registry/reasoner"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: { agent?: { id: string }; recentAudit: unknown[]; gateway: { calls30d: number } } };
    expect(body.data?.agent?.id).toBe("reasoner");
    expect(Array.isArray(body.data?.recentAudit)).toBe(true);
    expect(body.data?.gateway?.calls30d).toBe(0);
  });
});
