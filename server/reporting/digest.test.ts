import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { getTenantContext } from "../tenancy/context.ts";
import {
  collectDigestStats,
  DIGEST_INTERVAL_MS,
  DIGEST_MARKER_KEY,
  generateOperatorDigest,
  maybeGenerateDailyDigest,
  renderDigestText,
  shouldSendDailyDigest,
  shouldSendWeeklyDigest,
} from "./digest.ts";
import { seedDefaultAgents } from "../agents/registry.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevTelegramToken: string | undefined;
let prevTelegramChat: string | undefined;
let prevVaultDir: string | undefined;
let prevFetch: typeof fetch | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "digest-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  prevTelegramChat = process.env.TELEGRAM_CHAT_ID;
  prevVaultDir = process.env.DASHBOARD_AI_VAULT_DIR;
  prevFetch = globalThis.fetch;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.DASHBOARD_AI_VAULT_DIR = join(tempDir, "vault");
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
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
  if (prevTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
  if (prevTelegramChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = prevTelegramChat;
  if (prevVaultDir === undefined) delete process.env.DASHBOARD_AI_VAULT_DIR;
  else process.env.DASHBOARD_AI_VAULT_DIR = prevVaultDir;
  globalThis.fetch = prevFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

function db() {
  return getDashboardDb()!;
}

async function withMimuleTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  const req = new Request("http://localhost/", { headers: { "x-tenant-id": "mimule" } });
  const ctx = getTenantContext(req);
  return await tenantStore.run(ctx, fn) as T;
}

function seedCostEvents(now: number): void {
  const d = db();
  const rows = [
    { cost: 0, provider: "openrouter-free" },
    { cost: 0, provider: "openrouter-free" },
    { cost: 0, provider: "openrouter-free" },
    { cost: 12, provider: "openai-paid" },
  ];
  rows.forEach((r, i) => {
    d.query(
      `INSERT INTO cost_events (id, tenant_id, ts, source, logical_model, provider, tier, cost_cents, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`cost-${i}`, "mimule", now - i * 1000, "litellm", "editorial-fast", r.provider, r.provider.includes("free") ? "free" : "paid", r.cost, "list_price");
  });
}

function seedInsights(now: number): void {
  const d = db();
  const baseRow = "id, tenant_id, domain, severity, title, plain_summary, confidence, evidence_refs_json, manual_page_href, status, source_key, created_at";
  const placeholders = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
  d.query(`INSERT INTO insights (${baseRow}) VALUES (${placeholders})`)
    .run("ins-open-1", "mimule", "cost", "medium", "Free-first drift", "Some calls bypassed free tier", 0.7, "[]", "/governance", "open", "budget:d1", now - 1000);
  d.query(`INSERT INTO insights (${baseRow}) VALUES (${placeholders})`)
    .run("ins-open-2", "mimule", "security", "low", "Stale key", "key not rotated in 60d", 0.5, "[]", "/governance", "open", "sec:k1", now - 2000);
  d.query(`INSERT INTO insights (${baseRow}) VALUES (${placeholders})`)
    .run("ins-open-3", "mimule", "build", "low", "Old branch", "branch older than 14d", 0.4, "[]", "/governance", "open", "build:b1", now - 3000);
  d.query(
    `INSERT INTO insights (${baseRow}, resolved_at, resolution) VALUES (${placeholders}, ?, ?)`,
  ).run("ins-res-1", "mimule", "cost", "low", "Resolved cost", "auto", 0.6, "[]", "/governance", "resolved", "budget:r1", now - 4000, now - 500, "auto: stale");
  d.query(
    `INSERT INTO insights (${baseRow}, resolved_at, resolution) VALUES (${placeholders}, ?, ?)`,
  ).run("ins-res-2", "mimule", "security", "low", "Resolved sec", "auto", 0.6, "[]", "/governance", "resolved", "sec:r1", now - 4500, now - 600, "auto: stale");
  d.query(`INSERT INTO insights (${baseRow}) VALUES (${placeholders})`)
    .run("ins-app-1", "mimule", "cost", "low", "Applied cost", "user clicked apply", 0.7, "[]", "/governance", "applied", "cost:a1", now - 1500);
}

function seedReasonerIncidents(now: number): void {
  const d = db();
  d.query(
    `INSERT INTO reasoner_incidents (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count, representative_pass_id, representative_diagnosis_id, status, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("inc-1", "ck-1", "timeout", "Timed out twice", now - 10000, now - 1000, 2, "p1", "d1", "open", "mimule");
  d.query(
    `INSERT INTO reasoner_incidents (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count, representative_pass_id, representative_diagnosis_id, status, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("inc-2", "ck-2", "parse", "Bad JSON", now - 5000, now - 2000, 1, "p2", "d2", "open", "mimule");
}

function seedAgentsAndAudit(now: number): void {
  const d = db();
  seedDefaultAgents();
  d.query(
    `INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(now - 1000, "opencode-runner", "agent", "agent.run", "agent.run", "agent", "opencode-runner", "success", "mimule");
  d.query(
    `INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(now - 2000, "opencode-runner", "agent", "agent.run", "agent.run", "agent", "opencode-runner", "success", "mimule");
  d.query(
    `INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(now - 3000, "insights-scanner", "agent", "insights.scan", "insights.scan", "agent", "insights-scanner", "success", "mimule");
}

function seedModelEval(now: number): void {
  const d = db();
  d.query(
    `INSERT INTO metric_samples (ts, source, key, value_json, tenant_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(now - 100, "model-eval", "openrouter/nemotron", JSON.stringify({ score: 8, latencyMs: 1200, ts: now - 100, dateKey: "2026-06-10", error: null }), "mimule");
  d.query(
    `INSERT INTO metric_samples (ts, source, key, value_json, tenant_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(now - 200, "model-eval", "openrouter/gemma-31b", JSON.stringify({ score: 6, latencyMs: 1800, ts: now - 200, dateKey: "2026-06-10", error: null }), "mimule");
}

function seedHealthTrend(now: number): void {
  const d = db();
  d.query(
    `INSERT INTO metric_samples (ts, source, key, value_json, tenant_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(now - 60_000, "health", "admin_health_score", JSON.stringify(91), "mimule");
  d.query(
    `INSERT INTO metric_samples (ts, source, key, value_json, tenant_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(now - 30_000, "health", "admin_health_score", JSON.stringify(94), "mimule");
}

function seedBudgetAndAutofix(now: number): void {
  const d = db();
  d.query(
    `INSERT INTO governance_budgets (id, tenant_id, scope, project_id, daily_cap_usd, monthly_cap_usd, warn_pct, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("budget-global", "mimule", "global", null, 1, 30, 0.8, now - 10_000, now - 10_000);
  d.query(
    `INSERT INTO action_audit (ts, actor, actor_source, action_kind, action, action_id, target_type, target_id, result, result_status, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(now - 500, "system", "scheduler", "insights.auto-apply", "insights.auto-apply", "mutate-policy:model:test:cooldown-clear", "insight", "ins-auto", "auto-cleared expired cooldown", "success", "mimule");
}

describe("generateOperatorDigest", () => {
  test("text contains real numbers and stays under 3000 chars", async () => {
    await withMimuleTenant(async () => {
      const now = Date.now();
      seedCostEvents(now);
      seedInsights(now);
      seedReasonerIncidents(now);
      seedAgentsAndAudit(now);
      seedModelEval(now);
      seedHealthTrend(now);
      seedBudgetAndAutofix(now);

      const result = await generateOperatorDigest({ force: true });
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text.length).toBeLessThanOrEqual(3000);
      expect(result.sent).toBe(false);
      expect(result.text).toContain("Daily operator digest");
      expect(result.text).toContain("The system handled routine checks");
      expect(result.text).toContain("Health trend: Admin Health");
      expect(result.text).toContain("Trust score:");
      expect(result.text).toContain("/100");
      expect(result.text).toContain("Cost: 4 event(s)");
      expect(result.text).toContain("total $0.12");
      expect(result.text).toContain("75% free-tier");
      expect(result.text).toContain("Cost vs cap:");
      expect(result.text).toContain("Insights: 6 opened, 2 auto-resolved, 1 applied.");
      expect(result.text).toContain("Auto-fixes applied: 1");
      expect(result.text).toContain("Top open findings:");
      expect(result.text).toContain("Reasoner incidents");
      expect(result.text).toMatch(/Top agents by audit activity:/);
      expect(result.text).toMatch(/OpenCode Runner/);
      expect(result.text).toContain("Best model (latest eval): openrouter/nemotron (score 8).");
    });
  });

  test("persists archive row and audit row with actionKind 'reports.digest'", async () => {
    await withMimuleTenant(async () => {
      const now = Date.now();
      seedCostEvents(now);
      seedInsights(now);
      seedReasonerIncidents(now);
      seedAgentsAndAudit(now);
      seedModelEval(now);

      const before = Date.now();
      const result = await generateOperatorDigest({ force: true });
      expect(result.text.length).toBeGreaterThan(0);

      const archiveRow = db()
        .query(`SELECT kind, path, summary FROM report_archive WHERE kind = 'daily-digest' ORDER BY id DESC LIMIT 1`)
        .get() as { kind: string; path: string; summary: string } | null;
      expect(archiveRow).not.toBeNull();
      expect(archiveRow!.kind).toBe("daily-digest");
      expect(archiveRow!.summary.length).toBeGreaterThan(0);
      const vaultPath = join(tempDir, "vault", "daily", `${new Date().toISOString().slice(0, 10)}.md`);
      expect(existsSync(vaultPath)).toBe(true);
      expect(readFileSync(vaultPath, "utf8")).toContain("Daily operator digest");

      const auditRow = db()
        .query(`SELECT action_kind, result_status FROM action_audit WHERE action_kind = 'reports.digest' ORDER BY id DESC LIMIT 1`)
        .get() as { action_kind: string; result_status: string } | null;
      expect(auditRow).not.toBeNull();
      expect(auditRow!.action_kind).toBe("reports.digest");

      const marker = db()
        .query(`SELECT value_json, updated_by FROM system_configs WHERE key = ?`)
        .get(DIGEST_MARKER_KEY) as { value_json: string; updated_by: string } | null;
      expect(marker).not.toBeNull();
      const parsed = JSON.parse(marker!.value_json) as { lastDigestAt: number; tenantId: string };
      expect(parsed.lastDigestAt).toBeGreaterThanOrEqual(before);
      expect(parsed.tenantId).toBe("mimule");
      expect(marker!.updated_by).toBe("digest-scheduler");
    });
  });

  test("marker prevents resend within 24h; force=true still runs", async () => {
    await withMimuleTenant(async () => {
      const now = Date.now();
      seedCostEvents(now);
      seedInsights(now);
      seedReasonerIncidents(now);
      seedAgentsAndAudit(now);
      seedModelEval(now);

      const first = await generateOperatorDigest({ force: true });
      expect(first.text.length).toBeGreaterThan(0);
      expect(shouldSendDailyDigest(false)).toBe(false);
      expect(shouldSendWeeklyDigest(false)).toBe(false);

      const second = await generateOperatorDigest();
      expect(second.sent).toBe(false);
      expect(second.text).toMatch(/already sent/i);

      const third = await generateOperatorDigest({ force: true });
      expect(third.text.length).toBeGreaterThan(0);
      expect(third.text).toContain("Trust score:");

      const marker = db()
        .query(`SELECT value_json FROM system_configs WHERE key = ?`)
        .get(DIGEST_MARKER_KEY) as { value_json: string } | null;
      const parsed = JSON.parse(marker!.value_json) as { lastDigestAt: number };
      expect(Date.now() - parsed.lastDigestAt).toBeLessThan(5_000);
    });
  });

  test("daily gate skips first boot, sends once when due, and does not send twice", async () => {
    await withMimuleTenant(async () => {
      const now = Date.now();
      seedCostEvents(now);
      seedInsights(now);
      seedBudgetAndAutofix(now);

      const firstBoot = await maybeGenerateDailyDigest({ firstBootTick: true });
      expect(firstBoot.ran).toBe(false);
      expect(firstBoot.reason).toBe("first-boot");

      const notDue = await maybeGenerateDailyDigest();
      expect(notDue.ran).toBe(false);
      expect(notDue.reason).toBe("not-due");

      db().query(
        `UPDATE system_configs SET value_json = ?, updated_at = ? WHERE key = ?`,
      ).run(JSON.stringify({ lastDigestAt: Date.now() - DIGEST_INTERVAL_MS - 1000, tenantId: "mimule" }), Date.now(), DIGEST_MARKER_KEY);

      const due = await maybeGenerateDailyDigest();
      expect(due.ran).toBe(true);
      expect(due.text).toContain("Daily operator digest");

      const repeat = await maybeGenerateDailyDigest();
      expect(repeat.ran).toBe(false);
      expect(repeat.reason).toBe("not-due");

      const archiveCount = db().query(`SELECT COUNT(*) AS count FROM report_archive WHERE kind = 'daily-digest'`)
        .get() as { count: number };
      expect(archiveCount.count).toBe(1);
    });
  });

  test("telegram failure is swallowed after vault append and audit", async () => {
    await withMimuleTenant(async () => {
      process.env.TELEGRAM_BOT_TOKEN = "digest-test-token";
      process.env.TELEGRAM_CHAT_ID = "digest-chat";
      globalThis.fetch = (async () => {
        throw new Error("network unavailable in test");
      }) as unknown as typeof fetch;
      const result = await generateOperatorDigest({ force: true });
      expect(result.sent).toBe(false);
      expect(result.text).toContain("Daily operator digest");
      const auditRow = db().query(`SELECT result_json FROM action_audit WHERE action_kind = 'reports.digest' ORDER BY id DESC LIMIT 1`)
        .get() as { result_json: string } | null;
      expect(auditRow).not.toBeNull();
      expect(auditRow!.result_json).toContain('"sent":false');
    });
  });

  test("text size remains bounded when data is huge", async () => {
    await withMimuleTenant(async () => {
      const now = Date.now();
      const d = db();
      for (let i = 0; i < 100; i++) {
        d.query(
          `INSERT INTO cost_events (id, tenant_id, ts, source, tier, cost_cents, cost_basis) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(`c-${i}`, "mimule", now - i * 100, "litellm", i % 2 ? "free" : "paid", i % 3, "list");
        d.query(
          `INSERT INTO insights (id, tenant_id, domain, severity, title, plain_summary, confidence, evidence_refs_json, manual_page_href, status, source_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(`i-${i}`, "mimule", "cost", "low", `t-${i}`, `p-${i}`, 0.5, "[]", "/governance", "open", `s-${i}`, now - i * 100);
      }
      for (let i = 0; i < 20; i++) {
        d.query(
          `INSERT INTO reasoner_incidents (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count, representative_pass_id, representative_diagnosis_id, status, tenant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(`r-${i}`, `ck-${i}`, "timeout", `t-${i}`, now - 10000, now - 1000, 1, "p", "d", "open", "mimule");
      }
      seedAgentsAndAudit(now);
      seedModelEval(now);

      const result = await generateOperatorDigest({ force: true });
      expect(result.text.length).toBeLessThanOrEqual(3000);
      expect(result.text).toContain("Cost: 100 event(s)");
      expect(result.text).toContain("Insights: 100 opened");
    });
  });

  test("collectDigestStats returns expected numeric shape", async () => {
    await withMimuleTenant(async () => {
      const now = Date.now();
      seedCostEvents(now);
      seedInsights(now);
      seedReasonerIncidents(now);
      seedAgentsAndAudit(now);
      seedModelEval(now);

      const stats = collectDigestStats();
      expect(stats.costEventsCount).toBe(4);
      expect(stats.costEventsTotalCents).toBe(12);
      expect(stats.zeroCostPct).toBe("75%");
      expect(stats.insightsOpened).toBe(6);
      expect(stats.insightsAutoResolved).toBe(2);
      expect(stats.insightsApplied).toBe(1);
      expect(stats.reasonerIncidents).toBe(2);
      expect(stats.topAgents.length).toBeGreaterThan(0);
      expect(stats.bestModel).not.toBeNull();
      expect(stats.bestModel!.model).toBe("openrouter/nemotron");
      expect(stats.bestModel!.score).toBe(8);
      expect(stats.healthScore).toBeGreaterThanOrEqual(0);
      expect(stats.topOpenFindings.length).toBe(3);
      expect(stats.costVsCap.spentCents).toBe(12);
    });
  });

  test("renderDigestText omits best model line when none", async () => {
    await withMimuleTenant(async () => {
      const stats = collectDigestStats();
      expect(stats.bestModel).toBeNull();
      const text = renderDigestText(stats);
      expect(text).not.toContain("Best model");
    });
  });

  test("DIGEST_INTERVAL_MS is 24 hours", () => {
    expect(DIGEST_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
