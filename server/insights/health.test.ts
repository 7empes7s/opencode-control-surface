import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import type { AdminBriefing } from "./health.ts";

const gatewayCalls: Array<{ model: string; caller?: string; prompt: string }> = [];

mock.module("../gateway/client.ts", () => ({
  complete: async (
    model: string,
    messages: Array<{ role: string; content: string }>,
    opts: { caller?: string } = {},
  ) => {
    gatewayCalls.push({ model, caller: opts.caller, prompt: messages[0]?.content ?? "" });
    return {
      model: "stub-briefing-model",
      choices: [{ message: { content: "LLM State of the Stack with correlated causes." } }],
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
  expect(gatewayCalls[0].prompt).toContain("Recent finding history:");
  expect(gatewayCalls[0].prompt).toContain("Gateway tunnel is down");
  expect(gatewayCalls[0].prompt).toContain("Build recovered after retry");
  expect(gatewayCalls[0].prompt).toContain("Related open finding clusters:");
  expect(gatewayCalls[0].prompt).toContain("source=edge:tunnel-down");
  expect(getAdminBriefing().source).toBe("llm");
});
