import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { getTenantContext } from "../tenancy/context.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import {
  collectRemediationStats,
  currentMonthWindow,
  generateMonthlyRemediationReport,
  maybeGenerateMonthlyRemediationReport,
  MONTHLY_REMEDIATION_KIND,
  renderRemediationReport,
} from "./remediation.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
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
  tempDir = mkdtempSync(join(tmpdir(), "remediation-test-"));
  previousFetch = globalThis.fetch;
  for (const key of ["DASHBOARD_DB", "DASHBOARD_DB_PATH", "DASHBOARD_AI_VAULT_DIR", "DASHBOARD_REPORTS_VAULT_DIR", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.DASHBOARD_AI_VAULT_DIR = join(tempDir, "vault");
  delete process.env.DASHBOARD_REPORTS_VAULT_DIR;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  globalThis.fetch = (async () => { throw new Error("test fetch must not reach the network"); }) as unknown as typeof fetch;
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

function insertIncident(values: {
  id: string;
  failureClass: string;
  title: string;
  firstSeen: number;
  lastSeen: number;
  occurrenceCount: number;
  status: "open" | "resolved";
  resolvedAt?: number;
}): void {
  db().query(`INSERT INTO reasoner_incidents
    (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
      representative_pass_id, representative_diagnosis_id, status, tenant_id, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mimule', ?)`)
    .run(values.id, `cluster-${values.id}`, values.failureClass, values.title, values.firstSeen, values.lastSeen,
      values.occurrenceCount, `pass-${values.id}`, `diagnosis-${values.id}`, values.status, values.resolvedAt ?? null);
}

function seedRemediationPeriod(periodStart: number): void {
  const day = 24 * 60 * 60 * 1000;
  insertIncident({
    id: "auto-week-one", failureClass: "timeout", title: "Worker timeout", firstSeen: periodStart + day,
    lastSeen: periodStart + 2 * day, occurrenceCount: 6, status: "resolved", resolvedAt: periodStart + 2 * day,
  });
  insertIncident({
    id: "auto-old-birth", failureClass: "network", title: "Tunnel reset", firstSeen: periodStart + 2 * day,
    lastSeen: periodStart + 9 * day, occurrenceCount: 12, status: "resolved", resolvedAt: periodStart + 9 * day,
  });
  insertIncident({
    id: "manual-week-two", failureClass: "parse", title: "Malformed payload", firstSeen: periodStart + 8 * day,
    lastSeen: periodStart + 10 * day, occurrenceCount: 4, status: "resolved", resolvedAt: periodStart + 10 * day,
  });
  insertIncident({
    id: "open-flapper", failureClass: "rate-limit", title: "Provider throttling", firstSeen: periodStart + 3 * day,
    lastSeen: periodStart + 12 * day, occurrenceCount: 20, status: "open",
  });

  db().query(`INSERT INTO action_audit
    (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
    VALUES (?, 'system', 'scheduler', 'incidents.auto-close', 'incidents.auto-close', 'incident', 'auto-week-one', 'success', 'mimule'),
           (?, 'system', 'scheduler', 'incidents.auto-resolve', 'incidents.auto-resolve', 'incident', 'auto-old-birth', 'success', 'mimule'),
           (?, 'system', 'scheduler', 'incidents.auto-close', 'incidents.auto-close', 'incident', 'manual-week-two', 'failed', 'mimule'),
           (?, 'system', 'scheduler', 'incidents.auto-close', 'incidents.auto-close', 'incident', 'missing-incident', 'success', 'mimule')`)
    .run(periodStart + 2 * day, periodStart + 9 * day, periodStart + 10 * day, periodStart + 10 * day);

  const columns = `id, tenant_id, domain, severity, title, plain_summary, confidence,
    evidence_refs_json, manual_page_href, status, source_key, created_at, resolved_at, resolution`;
  db().query(`INSERT INTO insights (${columns}) VALUES
    ('rec-open', 'mimule', 'ops', 'medium', 'Recurring timeout', 'summary', 0.8, '[]', '/reasoner', 'open', 'remediation:recurrence:open', ?, NULL, NULL),
    ('rec-cleared', 'mimule', 'ops', 'low', 'Cleared recurrence', 'summary', 0.8, '[]', '/reasoner', 'resolved', 'remediation:recurrence:cleared', ?, ?, 'cleared'),
    ('rec-old-open', 'mimule', 'ops', 'low', 'Old open recurrence', 'summary', 0.8, '[]', '/reasoner', 'open', 'remediation:recurrence:old', ?, NULL, NULL)`)
    .run(periodStart + day, periodStart + 8 * day, periodStart + 11 * day, periodStart - day);
}

describe("monthly remediation report", () => {
  test("collects bounded weekly MTTR, intersection auto-remediation, recurrence, and ordered flappers", async () => {
    const periodStart = Date.UTC(2026, 5, 1);
    const periodEnd = periodStart + 4 * WEEK_MS;
    seedRemediationPeriod(periodStart);

    const stats = await withTenant(() => collectRemediationStats(periodStart, periodEnd));
    expect(stats.loopTrend.configured).toBe(true);
    if (!stats.loopTrend.configured) throw new Error("loop trend unavailable");
    expect(stats.loopTrend.buckets).toHaveLength(4);
    expect(stats.loopTrend.buckets[0]).toMatchObject({ resolved: 1, autoRemediated: 1, autoShare: 1, mttrMs: 24 * 60 * 60 * 1000 });
    expect(stats.loopTrend.buckets[1]).toMatchObject({ resolved: 2, autoRemediated: 1, autoShare: 0.5, mttrMs: 2 * 24 * 60 * 60 * 1000 });
    expect(stats.loopTrend.buckets[2]).toMatchObject({ resolved: 0, autoRemediated: 0, autoShare: null, mttrMs: null });
    expect(stats.loopTrend.overall.resolved).toBe(3);
    expect(stats.loopTrend.overall.autoRemediated).toBe(2);
    expect(stats.loopTrend.overall.autoShare).toBeCloseTo(2 / 3);
    expect(stats.loopTrend.buckets.every((bucket) => bucket.autoShare === null || bucket.autoShare <= 1)).toBe(true);

    expect(stats.recurrence).toEqual({ configured: true, raised: 2, cleared: 1, openNow: 2 });
    expect(stats.topFlappers.configured).toBe(true);
    if (stats.topFlappers.configured) {
      expect(stats.topFlappers.flappers.map((flapper) => flapper.title)).toEqual([
        "Provider throttling", "Tunnel reset", "Worker timeout", "Malformed payload",
      ]);
      expect(stats.topFlappers.flappers.map((flapper) => flapper.occurrenceCount)).toEqual([20, 12, 6, 4]);
    }

    const markdown = renderRemediationReport(stats, { start: periodStart, end: periodEnd });
    expect(markdown).toContain("| 1 (2026-06-01) | 1 | 1 | 100% | 24.0h |");
    expect(markdown).toContain("| 2 (2026-06-08) | 2 | 1 | 50% | 48.0h |");
    expect(markdown).toContain("Auto-remediation share trend:");
    expect(markdown).toContain("2 raised · 1 cleared · 2 open now");
  });

  test("empty database renders honest zeros and insufficient-data lines", async () => {
    const periodEnd = Date.UTC(2026, 6, 1);
    const periodStart = periodEnd - 4 * WEEK_MS;
    const stats = await withTenant(() => collectRemediationStats(periodStart, periodEnd));
    const markdown = renderRemediationReport(stats, { start: periodStart, end: periodEnd });

    expect(stats.loopTrend.configured && stats.loopTrend.overall).toMatchObject({ resolved: 0, autoRemediated: 0, autoShare: null, mttrMs: null });
    expect(stats.recurrence).toEqual({ configured: true, raised: 0, cleared: 0, openNow: 0 });
    expect(stats.topFlappers).toEqual({ configured: true, flappers: [] });
    expect(markdown).toContain("| **Period** | **0** | **0** | **insufficient data** | **insufficient data** |");
    expect(markdown).toContain("Auto-remediation share trend: insufficient data");
    expect(markdown).toContain("0 raised · 0 cleared · 0 open now");
    expect(markdown).toContain("No flappers this period.");
  });

  test("waits until the first at 07:00 UTC, generates once per month, persists rows, and force bypasses", async () => {
    const reference = Date.UTC(2026, 6, 15, 12);
    const { monthStart } = currentMonthWindow(reference);
    const before = monthStart + 6 * 60 * 60 * 1000;
    const after = monthStart + 8 * 60 * 60 * 1000;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";

    await withTenant(async () => {
      expect(await maybeGenerateMonthlyRemediationReport({ now: before })).toEqual({ generated: false, skipped: "before-window" });
      const first = await maybeGenerateMonthlyRemediationReport({ now: after });
      expect(first.generated).toBe(true);
      expect(first.path).toBe(join(tempDir, "vault", "monthly", "2026-07-remediation.md"));
      expect(first.path && existsSync(first.path)).toBe(true);
      expect(readFileSync(first.path!, "utf8")).toContain("# Remediation Loop Report — 2026-07");
      expect(await maybeGenerateMonthlyRemediationReport({ now: after + 1_000 })).toEqual({ generated: false, skipped: "already-generated" });
      expect((await generateMonthlyRemediationReport({ force: true, now: after + 2_000 })).generated).toBe(true);
    });

    const archive = db().query(`SELECT kind, path FROM report_archive WHERE kind = ? ORDER BY id`).all(MONTHLY_REMEDIATION_KIND) as Array<{ kind: string; path: string }>;
    expect(archive).toHaveLength(2);
    expect(archive[0]).toEqual({ kind: "monthly-remediation", path: "monthly/2026-07-remediation.md" });
    expect((db().query(`SELECT COUNT(*) AS count FROM report_runs WHERE template_id = ?`).get(MONTHLY_REMEDIATION_KIND) as { count: number }).count).toBe(2);
    expect((db().query(`SELECT COUNT(*) AS count FROM action_audit WHERE action_kind = 'reports.remediation'`).get() as { count: number }).count).toBe(2);
  });
});
