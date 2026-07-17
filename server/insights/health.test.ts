import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import type { AdminBriefing } from "./health.ts";

const gatewayCalls: Array<{
  model: string;
  caller?: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}> = [];
let gatewayResponseText = "LLM State of the Stack with correlated causes.";

mock.module("../gateway/client.ts", () => ({
  complete: async (
    model: string,
    messages: Array<{ role: string; content: string }>,
    opts: { caller?: string; maxTokens?: number; timeoutMs?: number } = {},
  ) => {
    gatewayCalls.push({
      model,
      caller: opts.caller,
      prompt: messages[0]?.content ?? "",
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
    });
    return {
      model: "stub-briefing-model",
      choices: [{ message: { content: gatewayResponseText } }],
    };
  },
}));

const {
  getAdminBriefing,
  refreshAdminBriefingIfStale,
  resetAdminBriefingCacheForTest,
} = await import("./health.ts");

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  resetAdminBriefingCacheForTest();
  gatewayCalls.length = 0;
  gatewayResponseText = "LLM State of the Stack with correlated causes.";
  tempDir = mkdtempSync(join(tmpdir(), "admin-health-test-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
});

afterEach(() => {
  closeDashboardDb();
  resetAdminBriefingCacheForTest();
  if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDashboardDb;
  if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function enableTestDb(): ReturnType<typeof getDashboardDb> {
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  return getDashboardDb();
}

test("admin briefing returns a local daily fallback when no DB cache exists", () => {
  delete process.env.DASHBOARD_DB;

  const briefing = getAdminBriefing();

  expect(briefing.source).toBe("fallback");
  expect(briefing.model).toBe("local-summary");
  expect(briefing.dateKey).toBe(new Date().toISOString().slice(0, 10));
  expect(briefing.text).toContain("State of the stack");
  expect(briefing.text).toContain("Admin Health");
});

test("admin briefing loads today's persisted State of the Stack cache", () => {
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  const dateKey = new Date().toISOString().slice(0, 10);
  const cached: AdminBriefing = {
    text: "Cached daily State of the Stack.",
    model: "test-model",
    generatedAt: Date.now() - 60_000,
    dateKey,
    source: "llm",
  };
  getDashboardDb()!.query(
    `INSERT INTO system_configs (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)`,
  ).run(`admin_state_of_stack_briefing:${dateKey}`, JSON.stringify(cached), Date.now(), "test");

  const briefing = getAdminBriefing();

  expect(briefing).toEqual(cached);
});

test("admin briefing prompt includes recent history and related open findings", async () => {
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  const db = getDashboardDb()!;
  const now = Date.now();
  const insertInsight = db.query(
    `INSERT INTO insights (
      id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
      action_descriptor_id, manual_page_href, status, tenant_id, created_at, source_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertInsight.run(
    "insight-critical-gateway",
    "ops",
    "critical",
    "Gateway tunnel is down",
    "The gateway tunnel has stopped responding.",
    0.92,
    "[]",
    null,
    "/infra",
    "open",
    "default",
    now - 5 * 60_000,
    "edge:site-unreachable",
  );
  insertInsight.run(
    "insight-related-gateway",
    "ops",
    "high",
    "Public endpoint unreachable",
    "The public endpoint is failing health checks.",
    0.88,
    "[]",
    null,
    "/infra",
    "open",
    "default",
    now - 10 * 60_000,
    "edge:tunnel-down",
  );
  insertInsight.run(
    "insight-resolved-build",
    "build",
    "medium",
    "Build recovered after retry",
    "The latest retry passed.",
    0.75,
    "[]",
    null,
    "/builder",
    "resolved",
    "default",
    now - 20 * 60_000,
    "builder:validation",
  );

  await refreshAdminBriefingIfStale();

  expect(gatewayCalls).toHaveLength(1);
  expect(gatewayCalls[0].model).toBe("editorial-heavy");
  expect(gatewayCalls[0].caller).toBe("admin-briefing");
  expect(gatewayCalls[0].maxTokens).toBe(800);
  expect(gatewayCalls[0].timeoutMs).toBe(15_000);
  expect(gatewayCalls[0].prompt).toContain("Recent finding history:");
  expect(gatewayCalls[0].prompt).toContain("Gateway tunnel is down");
  expect(gatewayCalls[0].prompt).toContain("Build recovered after retry");
  expect(gatewayCalls[0].prompt).toContain("Related open finding clusters:");
  expect(gatewayCalls[0].prompt).toContain("source=edge:tunnel-down");
  expect(getAdminBriefing().source).toBe("llm");
});

test("admin briefing rejects the verbatim operator-reported scratchpad without persisting it", async () => {
  const db = enableTestDb()!;
  gatewayResponseText = "The user wants a 2-3 sentence \"State of the Stack\" briefing. I need to be specific, connect findings to root causes, avoid filler. Key data points: - Admin Health: 80/100 (decent) — Product Health: 0 fails (good) … Pipeline paused is";

  await refreshAdminBriefingIfStale();

  expect(getAdminBriefing().source).toBe("fallback");
  const stored = db.query(
    `SELECT COUNT(*) AS count FROM system_configs WHERE key LIKE 'admin_state_of_stack_briefing:%'`,
  ).get() as { count: number };
  expect(stored.count).toBe(0);
});

test("admin briefing rejects valid-looking prose truncated mid-sentence", async () => {
  enableTestDb();
  gatewayResponseText = "Admin Health is stable, but the pipeline remains paused while operators investigate";

  await refreshAdminBriefingIfStale();

  expect(getAdminBriefing().source).toBe("fallback");
});

test("admin briefing rejects prompt scaffolding echoed by the model", async () => {
  enableTestDb();
  gatewayResponseText = "The stack is stable. Key data points show no critical failures.";

  await refreshAdminBriefingIfStale();

  expect(getAdminBriefing().source).toBe("fallback");
});

test("admin briefing accepts and byte-preserves a good briefing", async () => {
  const db = enableTestDb()!;
  const good = "Admin Health is stable with no critical findings. The paused pipeline remains the main operational concern.";
  gatewayResponseText = good;

  await refreshAdminBriefingIfStale();

  const briefing = getAdminBriefing();
  expect(briefing.source).toBe("llm");
  expect(briefing.text).toBe(good);
  const dateKey = new Date().toISOString().slice(0, 10);
  const stored = db.query(
    `SELECT value_json FROM system_configs WHERE key = ?`,
  ).get(`admin_state_of_stack_briefing:${dateKey}`) as { value_json: string };
  const persisted = JSON.parse(stored.value_json) as AdminBriefing;
  expect(persisted.source).toBe("llm");
  expect(persisted.text).toBe(good);
});

test("admin briefing strips delimited reasoning before accepting the final text", async () => {
  enableTestDb();
  gatewayResponseText = "<think>noise</think>Real briefing.";

  await refreshAdminBriefingIfStale();

  const briefing = getAdminBriefing();
  expect(briefing.source).toBe("llm");
  expect(briefing.text).toBe("Real briefing.");
});

test("admin briefing rejects reasoning-only output", async () => {
  const db = enableTestDb()!;
  gatewayResponseText = "<think>noise</think>";

  await refreshAdminBriefingIfStale();

  expect(getAdminBriefing().source).toBe("fallback");
  const stored = db.query(
    `SELECT COUNT(*) AS count FROM system_configs WHERE key LIKE 'admin_state_of_stack_briefing:%'`,
  ).get() as { count: number };
  expect(stored.count).toBe(0);
});

test("admin briefing discards persisted scratchpad garbage and self-heals to fallback", () => {
  const db = enableTestDb()!;
  const dateKey = new Date().toISOString().slice(0, 10);
  const scratchpad: AdminBriefing = {
    text: "The user wants a concise briefing. I need to summarize the operational findings.",
    model: "reasoning-model",
    generatedAt: Date.now() - 60_000,
    dateKey,
    source: "llm",
  };
  db.query(
    `INSERT INTO system_configs (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)`,
  ).run(`admin_state_of_stack_briefing:${dateKey}`, JSON.stringify(scratchpad), Date.now(), "test");

  expect(getAdminBriefing().source).toBe("fallback");
  const stored = db.query(
    `SELECT COUNT(*) AS count FROM system_configs WHERE key = ?`,
  ).get(`admin_state_of_stack_briefing:${dateKey}`) as { count: number };
  expect(stored.count).toBe(0);
});

test("admin briefing rejection emits an observable metric sample", async () => {
  const db = enableTestDb()!;
  gatewayResponseText = "I should summarize the stack before giving the operator an answer.";

  await refreshAdminBriefingIfStale();

  const sample = db.query(
    `SELECT value_json FROM metric_samples
     WHERE source = 'health' AND key = 'admin_briefing_rejected'
     ORDER BY ts DESC LIMIT 1`,
  ).get() as { value_json: string } | null;
  expect(sample).not.toBeNull();
  expect(JSON.parse(sample!.value_json)).toBe(1);
});
