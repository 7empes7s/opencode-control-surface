import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { getTenantContext } from "../tenancy/context.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import {
  collectExecutiveStats,
  generateWeeklyExecutiveReport,
  mondayWindow,
  maybeGenerateWeeklyExecutiveReport,
  renderExecutiveReport,
  WEEKLY_EXECUTIVE_KIND,
} from "./executive.ts";

const savedEnv: Record<string, string | undefined> = {};
let tempDir: string;
let previousFetch: typeof fetch;

function db() {
  return getDashboardDb()!;
}

async function withTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  const context = getTenantContext(new Request("http://localhost", { headers: { "x-tenant-id": "mimule" } }));
  return await tenantStore.run(context, fn) as T;
}

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "executive-test-"));
  previousFetch = globalThis.fetch;
  for (const key of ["DASHBOARD_DB", "DASHBOARD_DB_PATH", "DASHBOARD_MODEL_HEALTH_PATH", "DASHBOARD_AI_VAULT_DIR", "DASHBOARD_NEWSBITES_DEPLOY_CMD", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.DASHBOARD_MODEL_HEALTH_PATH = join(tempDir, "model-health.json");
  process.env.DASHBOARD_AI_VAULT_DIR = join(tempDir, "reports");
  process.env.DASHBOARD_NEWSBITES_DEPLOY_CMD = "test-deploy";
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = previousFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

function seedRealData(now: number): void {
  const periodStart = now - 7 * 24 * 60 * 60 * 1000;
  db().query(`INSERT INTO metric_samples (ts, source, key, value_json, tenant_id) VALUES (?, 'trust-score', 'daily', ?, 'mimule')`)
    .run(now - 6 * 24 * 60 * 60 * 1000, JSON.stringify({ score: 62 }));
  db().query(`INSERT INTO gateway_calls
    (ts, tenant_id, logical_model, resolved_model, backend, tier, prompt_tokens, completion_tokens, latency_ms, cost_estimate_usd, success)
    VALUES (?, 'mimule', 'editorial', 'test', 'test', 'cloud-paid', 1000, 500, 10, 0.5, 1),
           (?, 'mimule', 'editorial', 'test', 'test', 'cloud-free', 2000, 1000, 10, 0, 1)`)
    .run(now - 3 * 24 * 60 * 60 * 1000, now - 2 * 24 * 60 * 60 * 1000);
  db().query(`INSERT INTO cost_events
    (id, tenant_id, ts, source, logical_model, provider, tier, cost_cents, cost_basis)
    VALUES ('cost-1', 'mimule', ?, 'litellm', 'editorial', 'test', 'paid', 50, 'list_price')`)
    .run(now - 3 * 24 * 60 * 60 * 1000);
  db().query(`INSERT INTO provider_price_catalog
    (id, tenant_id, provider, logical_model, tier, input_cents_per_1k, output_cents_per_1k, effective_from)
    VALUES ('baseline', 'mimule', 'test', NULL, 'cloud-paid', 0.5, 1, 0)`).run();

  db().query(`INSERT INTO reasoner_incidents
    (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count, representative_pass_id, representative_diagnosis_id, status, tenant_id, resolved_at)
    VALUES ('inc-open', 'open', 'timeout', 'Opened', ?, ?, 1, 'p1', 'd1', 'open', 'mimule', NULL),
           ('inc-closed', 'closed', 'timeout', 'Closed', ?, ?, 1, 'p2', 'd2', 'resolved', 'mimule', ?)`)
    .run(now - 2_000, now - 1_000, now - 7_200_000, now - 1_000, now - 3_600_000);
  db().query(`INSERT INTO action_audit
    (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
    VALUES (?, 'scheduler', 'system', 'incidents.auto-close', 'incidents.auto-close', 'incident', 'inc-closed', 'success', 'mimule')`)
    .run(now - 3_500_000);

  db().query(`INSERT INTO jobs (id, ts, kind, state, status, started_at, finished_at, tenant_id)
    VALUES ('deploy-1', ?, 'newsbites-deploy', 'success', 'success', ?, ?, 'mimule')`)
    .run(now - 10_000, now - 10_000, now - 5_000);
  db().query(`INSERT INTO metric_samples (ts, source, key, value_json, tenant_id)
    VALUES (?, 'newsbites', 'published', ?, 'mimule'), (?, 'newsbites', 'published', ?, 'mimule')`)
    .run(periodStart, JSON.stringify({ totalPublished: 40 }), now, JSON.stringify({ totalPublished: 43 }));

  const insightColumns = `id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
    action_descriptor_id, manual_page_href, status, tenant_id, created_at, source_key`;
  db().query(`INSERT INTO insights (${insightColumns}) VALUES
    ('risk-critical', 'ops', 'critical', 'Critical risk', 'summary', 0.9, '[]', 'start-job:model-health:all', '/models', 'open', 'mimule', ?, 'risk:critical'),
    ('risk-high', 'security', 'high', 'High risk', 'summary', 0.8, '[]', NULL, '/security', 'open', 'mimule', ?, 'risk:high')`)
    .run(now - 1_000, now - 500);
  writeFileSync(process.env.DASHBOARD_MODEL_HEALTH_PATH!, JSON.stringify({
    lastFullCheckAt: now,
    models: [{ available: true }, { available: true }, { available: false, error: "down" }],
  }));
}

describe("weekly executive report", () => {
  test("collects real tenant-scoped values from seeded sources", async () => {
    const now = Date.now();
    seedRealData(now);
    const stats = await withTenant(() => collectExecutiveStats(now - 7 * 24 * 60 * 60 * 1000, now));

    expect(stats.healthScore.configured).toBe(true);
    expect(stats.incidents).toMatchObject({ configured: true, opened: 2, closed: 1, autoRemediated: 1, autoRemediatedShare: 1 });
    if (stats.incidents.configured) expect(stats.incidents.mttrMs).toBe(3_600_000);
    expect(stats.cost).toMatchObject({ configured: true, monthToDateCents: 50, savedByFreeFirstCents: 2 });
    expect(stats.modelAvailability).toMatchObject({ configured: true, healthy: 2, total: 3 });
    expect(stats.deploys).toEqual({ configured: true, count: 1 });
    expect(stats.contentPublished).toEqual({ configured: true, count: 3 });
    if (stats.topRisks.configured) {
      expect(stats.topRisks.risks[0]).toMatchObject({ severity: "critical", title: "Critical risk", actionId: "start-job:model-health:all" });
    }
  });

  test("renders honest labels for empty or unavailable sources", async () => {
    const now = Date.now();
    const stats = await withTenant(() => collectExecutiveStats(now - 7 * 24 * 60 * 60 * 1000, now));
    const markdown = renderExecutiveReport(stats, { start: now - 7 * 24 * 60 * 60 * 1000, end: now });

    expect(stats.cost).toEqual({ configured: false });
    expect(stats.modelAvailability).toEqual({ configured: false });
    expect(stats.deploys).toEqual({ configured: true, count: 0 });
    expect(stats.contentPublished).toEqual({ configured: false });
    expect(markdown).toContain("Not configured: cost data is unavailable.");
    expect(markdown).toContain("Not configured: model-health data is absent or stale.");
    expect(markdown).toContain("Content published: not configured (no reliable ingested baseline).");
    expect(markdown).toContain("Deploys shipped: 0");
    expect(markdown).toContain("MTTR insufficient data");
  });

  test("waits until Monday 07:00 UTC, generates once, archives, and tolerates Telegram failure", async () => {
    const reference = Date.UTC(2026, 6, 8, 12);
    const { mondayStart } = mondayWindow(reference);
    const before = mondayStart + 6 * 60 * 60 * 1000;
    const after = mondayStart + 8 * 60 * 60 * 1000;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

    await withTenant(async () => {
      expect(await maybeGenerateWeeklyExecutiveReport({ now: before })).toEqual({ generated: false, skipped: "before-window" });
      const first = await maybeGenerateWeeklyExecutiveReport({ now: after });
      expect(first.generated).toBe(true);
      expect(first.path && existsSync(first.path)).toBe(true);
      expect(await maybeGenerateWeeklyExecutiveReport({ now: after + 1_000 })).toEqual({ generated: false, skipped: "already-generated" });
    });

    const archive = db().query(`SELECT kind, path FROM report_archive WHERE kind = ?`).get(WEEKLY_EXECUTIVE_KIND) as { kind: string; path: string };
    expect(archive.kind).toBe("weekly-executive");
    expect(archive.path).toContain("weekly/");
    expect((db().query(`SELECT COUNT(*) AS count FROM report_archive WHERE kind = ?`).get(WEEKLY_EXECUTIVE_KIND) as { count: number }).count).toBe(1);
  });

  test("force generation returns a file even when Telegram is not configured", async () => {
    const result = await withTenant(() => generateWeeklyExecutiveReport({ force: true, now: Date.now() }));
    expect(result.generated).toBe(true);
    expect(result.path && existsSync(result.path)).toBe(true);
  });
});
