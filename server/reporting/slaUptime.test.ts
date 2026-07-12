import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { getTenantContext } from "../tenancy/context.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { mondayWindow } from "./executive.ts";
import {
  collectSlaUptimeStats,
  generateWeeklySlaUptimeReport,
  maybeGenerateWeeklySlaUptimeReport,
  renderSlaUptimeReport,
  WEEKLY_SLA_UPTIME_KIND,
} from "./slaUptime.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
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
  tempDir = mkdtempSync(join(tmpdir(), "sla-uptime-test-"));
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

function insertSample(ts: number, service: string, state: "active" | "inactive" | "unknown", tenantId: string | null = "mimule"): void {
  db().query("INSERT INTO metric_samples (ts, source, key, value_json, tenant_id) VALUES (?, 'services', ?, ?, ?)")
    .run(ts, `${service}.state`, JSON.stringify({ state }), tenantId);
}

function insertBreach(id: string, createdAt: number, status: "open" | "resolved", resolvedAt: number | null): void {
  db().query(`INSERT INTO insights
    (id, domain, severity, title, plain_summary, confidence, evidence_refs_json, manual_page_href,
      status, tenant_id, created_at, source_key, resolved_at)
    VALUES (?, 'ops', 'high', ?, 'SLA threshold exceeded', 1, '[]', '/services', ?, 'mimule', ?, ?, ?)`)
    .run(id, `SLA breach ${id}`, status, createdAt, `ops:sla-breach:${id}`, resolvedAt);
}

describe("weekly SLA uptime report", () => {
  test("excludes unknown samples from uptime, ranks worst first, and counts breaches and near-misses", async () => {
    const periodStart = Date.UTC(2026, 6, 6);
    const periodEnd = periodStart + DAY_MS;
    insertSample(periodStart + 1, "alpha", "active");
    insertSample(periodStart + 2, "alpha", "active");
    insertSample(periodStart + 3, "alpha", "inactive");
    insertSample(periodStart + 4, "alpha", "inactive");
    insertSample(periodStart + 5, "alpha", "unknown");
    for (let index = 0; index < 19; index++) insertSample(periodStart + 10 + index, "zulu", "active");
    insertSample(periodStart + 40, "zulu", "inactive");
    insertSample(periodStart + 50, "ghost", "unknown");
    insertSample(periodStart + 51, "ghost", "unknown");
    insertSample(periodStart + 52, "ghost", "unknown");
    insertSample(periodStart + 60, "other-tenant", "inactive", "another-tenant");
    insertSample(periodStart - 1, "outside", "inactive");
    insertBreach("open", periodStart + 100, "open", null);
    insertBreach("resolved", periodStart + 200, "resolved", periodStart + 300);
    insertBreach("ancient", periodStart - DAY_MS, "resolved", periodStart - 1);

    const stats = await withTenant(() => collectSlaUptimeStats(periodStart, periodEnd));
    expect(stats.configured).toBe(true);
    if (!stats.configured) throw new Error("SLA uptime source unavailable");

    expect(stats.services.map((service) => service.service)).toEqual(["alpha", "zulu"]);
    expect(stats.services[0]).toEqual({
      service: "alpha",
      upSamples: 2,
      downSamples: 2,
      uptimePercent: 50,
      unmeasuredSamples: 1,
    });
    expect(stats.services[1].uptimePercent).toBe(95);
    expect(stats.noDataServices).toEqual(["ghost"]);
    expect(stats.overall).toEqual({ uptimePercent: 87.5, upSamples: 21, downSamples: 3 });
    expect(stats.nearMisses).toEqual({ count: 1, names: ["zulu"] });
    expect(stats.breaches).toEqual({ raised: 2, resolved: 1, openNow: 1 });

    const markdown = renderSlaUptimeReport(stats, { start: periodStart, end: periodEnd });
    expect(markdown).toContain("# SLA / Uptime Report — 2026-W28");
    expect(markdown).toContain("87.50% overall (21 up / 3 down samples; unknown samples excluded).");
    expect(markdown.indexOf("| alpha | 50.00%")) .toBeLessThan(markdown.indexOf("| zulu | 95.00%"));
    expect(markdown).toContain("2 raised · 1 resolved · 1 open now.");
    expect(markdown).toContain("1 near-miss (threshold: 90% ≤ uptime < 100%): zulu.");
    expect(markdown).toContain("Monitored but no determinate state this period: ghost.");
  });

  test("renders measured-source emptiness and all-unknown services honestly", async () => {
    const periodEnd = Date.UTC(2026, 6, 13, 7);
    const periodStart = periodEnd - 7 * DAY_MS;
    let stats = await withTenant(() => collectSlaUptimeStats(periodStart, periodEnd));
    expect(stats.configured).toBe(true);
    expect(renderSlaUptimeReport(stats, { start: periodStart, end: periodEnd }))
      .toContain("No measured services this period.");

    insertSample(periodStart + 1, "missing-host-service", "unknown");
    stats = await withTenant(() => collectSlaUptimeStats(periodStart, periodEnd));
    expect(stats.configured).toBe(true);
    if (!stats.configured) throw new Error("SLA uptime source unavailable");
    expect(stats.services).toEqual([]);
    expect(stats.overall.uptimePercent).toBeNull();
    expect(stats.noDataServices).toEqual(["missing-host-service"]);
    const markdown = renderSlaUptimeReport(stats, { start: periodStart, end: periodEnd });
    expect(markdown).toContain("No measured services this period.");
    expect(markdown).toContain("Monitored but no determinate state this period: missing-host-service.");
    expect(markdown).not.toContain("0.00% overall");
  });

  test("reports not configured only when metric_samples is absent", async () => {
    db().exec("DROP TABLE metric_samples");
    const periodEnd = Date.UTC(2026, 6, 13, 7);
    const stats = await withTenant(() => collectSlaUptimeStats(periodEnd - 7 * DAY_MS, periodEnd));
    expect(stats).toEqual({ configured: false });
    expect(renderSlaUptimeReport(stats, { start: periodEnd - 7 * DAY_MS, end: periodEnd }))
      .toContain("Not configured: metric_samples is unavailable.");
  });

  test("waits for Monday 07:00, generates once, persists rows, and force bypasses", async () => {
    const reference = Date.UTC(2026, 6, 8, 12);
    const { mondayStart } = mondayWindow(reference);
    const before = mondayStart + 6 * 60 * 60 * 1000;
    const after = mondayStart + 8 * 60 * 60 * 1000;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";

    await withTenant(async () => {
      expect(await maybeGenerateWeeklySlaUptimeReport({ now: before })).toEqual({ generated: false, skipped: "before-window" });
      const first = await maybeGenerateWeeklySlaUptimeReport({ now: after });
      expect(first.generated).toBe(true);
      expect(first.path).toBe(join(tempDir, "vault", "weekly", "2026-07-06-sla-uptime.md"));
      expect(first.path && existsSync(first.path)).toBe(true);
      expect(readFileSync(first.path!, "utf8")).toContain("# SLA / Uptime Report — 2026-W28");
      expect(await maybeGenerateWeeklySlaUptimeReport({ now: after + 1_000 })).toEqual({ generated: false, skipped: "already-generated" });
      expect((await maybeGenerateWeeklySlaUptimeReport({ force: true, now: after + 2_000 })).generated).toBe(true);
    });

    const archive = db().query("SELECT kind, path FROM report_archive WHERE kind = ? ORDER BY id")
      .all(WEEKLY_SLA_UPTIME_KIND) as Array<{ kind: string; path: string }>;
    expect(archive).toHaveLength(2);
    expect(archive[0]).toEqual({ kind: WEEKLY_SLA_UPTIME_KIND, path: "weekly/2026-07-06-sla-uptime.md" });
    expect((db().query("SELECT COUNT(*) AS count FROM report_runs WHERE template_id = ?")
      .get(WEEKLY_SLA_UPTIME_KIND) as { count: number }).count).toBe(2);
    expect((db().query("SELECT COUNT(*) AS count FROM action_audit WHERE action_kind = 'reports.sla-uptime'")
      .get() as { count: number }).count).toBe(2);
  });

  test("direct force generation stays inside the injected vault", async () => {
    const result = await withTenant(() => generateWeeklySlaUptimeReport({ force: true, now: Date.UTC(2026, 6, 6, 8) }));
    expect(result.path?.startsWith(join(tempDir, "vault"))).toBe(true);
  });
});
