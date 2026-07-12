import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { getTenantContext } from "../tenancy/context.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import {
  collectSystemLaborStats,
  generateWeeklySystemLaborReport,
  maybeGenerateWeeklySystemLaborReport,
  renderSystemLaborReport,
  SYSTEM_LABOR_MINUTES_PER_ACTION,
  WEEKLY_SYSTEM_LABOR_KIND,
} from "./systemLabor.ts";
import { mondayWindow } from "./executive.ts";

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
  tempDir = mkdtempSync(join(tmpdir(), "system-labor-test-"));
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

function insertAudit(ts: number, actionKind: string, options: {
  actorSource?: string;
  status?: string;
  tenantId?: string | null;
} = {}): void {
  db().query(`INSERT INTO action_audit
    (ts, actor, actor_source, action_kind, action, target_type, target_id, result_status, tenant_id)
    VALUES (?, 'system', ?, ?, ?, 'system', ?, ?, ?)`)
    .run(ts, options.actorSource ?? "scheduler", actionKind, actionKind, actionKind,
      options.status ?? "success", options.tenantId === undefined ? "mimule" : options.tenantId);
}

function seedPeriod(periodStart: number): void {
  let offset = 1;
  const add = (kind: string, options?: Parameters<typeof insertAudit>[2]) => insertAudit(periodStart + offset++, kind, options);

  add("insights.auto-resolve", { actorSource: "sentinel-scan" }); // findings-cleared wins over probe
  add("insights.auto-resolve");
  add("insights.auto-dismiss");
  add("insights.auto-apply-policy");
  add("incidents.auto-close");
  add("incidents.auto-resolve");

  add("scan:discovery:models");
  add("scan:discovery:models");
  add("probe:model:editorial");

  add("reports.digest");
  add("reports.digest");
  add("reports.digest");
  add("reports.digest");

  add("run.newsbites");
  add("start-job:gateway:rebuild");
  add("autopipeline.command");
  add("autopipeline.command");

  add("reports.executive", { status: "failed" });
  add("probe:model:running", { status: "running" });
  add("reports.digest", { tenantId: "another-tenant" });
  add("unrelated.system.action");
  insertAudit(periodStart - 1, "reports.digest");
  insertAudit(periodStart + DAY_MS, "reports.digest");
}

describe("weekly system labor report", () => {
  test("separates findings housekeeping from real auto-fixes without hiding actions", async () => {
    const periodStart = Date.UTC(2026, 6, 6);
    const periodEnd = periodStart + DAY_MS;
    insertAudit(periodStart + 1, "insights.auto-resolve");
    insertAudit(periodStart + 2, "insights.auto-resolve");
    insertAudit(periodStart + 3, "insights.auto-dismiss");
    insertAudit(periodStart + 4, "insights.auto-apply-policy");
    insertAudit(periodStart + 5, "incidents.auto-close");
    insertAudit(periodStart + 6, "incidents.auto-resolve");

    const stats = await withTenant(() => collectSystemLaborStats(periodStart, periodEnd));
    expect(stats.configured).toBe(true);
    if (!stats.configured) throw new Error("system labor unavailable");

    expect(stats.categories.slice(0, 2)).toEqual([
      { label: "Auto-fixes applied", count: 3 },
      { label: "Findings auto-cleared", count: 3 },
    ]);
    expect(stats.totalActions).toBe(6);
    expect(stats.timeSaved).toMatchObject({
      configured: true,
      minutes: 15,
      assumptions: {
        "Auto-fixes applied": 5,
        "Findings auto-cleared": 0,
      },
    });
  });

  test("categorizes successful tenant work once, estimates time, and ranks action kinds", async () => {
    const periodStart = Date.UTC(2026, 6, 6);
    const periodEnd = periodStart + DAY_MS;
    seedPeriod(periodStart);

    const stats = await withTenant(() => collectSystemLaborStats(periodStart, periodEnd));
    expect(stats.configured).toBe(true);
    if (!stats.configured) throw new Error("system labor unavailable");

    expect(stats.categories).toEqual([
      { label: "Auto-fixes applied", count: 3 },
      { label: "Findings auto-cleared", count: 3 },
      { label: "Probes & scans run", count: 3 },
      { label: "Reports generated", count: 4 },
      { label: "Deploys run", count: 1 },
      { label: "Routing/chain actions", count: 1 },
      { label: "Pipeline actions", count: 2 },
    ]);
    expect(stats.totalActions).toBe(17);
    expect(stats.timeSaved).toEqual({
      configured: true,
      minutes: 102,
      assumptions: SYSTEM_LABOR_MINUTES_PER_ACTION,
    });
    expect(stats.busiest).toEqual([
      { name: "reports.digest", count: 4 },
      { name: "autopipeline.command", count: 2 },
      { name: "insights.auto-resolve", count: 2 },
    ]);

    const markdown = renderSystemLaborReport(stats, { start: periodStart, end: periodEnd });
    expect(markdown).toContain("performed 17 actions on your behalf");
    expect(markdown).toContain("weighted assumptions, that represents an estimated ~1.7 hours saved");
    expect(markdown).toContain("| Auto-fixes applied | 3 |");
    expect(markdown).toContain("| Findings auto-cleared | 3 |");
    expect(markdown).toContain("| Reports generated | 4 |");
    expect(markdown).toContain("1. `reports.digest` — 4");
    expect(markdown).toContain("Of these, 3 were findings auto-cleared (housekeeping, not counted toward the time-saved estimate).");
    expect(markdown).toContain("- Findings auto-cleared: 0 minutes (automated housekeeping — shown as activity, not counted toward time saved)");
    expect(markdown).toContain("Estimated total: 102 minutes (~1.7 hours).");
  });

  test("empty action audit renders real zeros and explicit assumptions", async () => {
    const periodEnd = Date.UTC(2026, 6, 13, 7);
    const periodStart = periodEnd - 7 * DAY_MS;
    const stats = await withTenant(() => collectSystemLaborStats(periodStart, periodEnd));
    const markdown = renderSystemLaborReport(stats, { start: periodStart, end: periodEnd });

    expect(stats.configured).toBe(true);
    if (!stats.configured) throw new Error("system labor unavailable");
    expect(stats.categories.every((category) => category.count === 0)).toBe(true);
    expect(stats.totalActions).toBe(0);
    expect(stats.timeSaved).toMatchObject({ configured: true, minutes: 0 });
    expect(stats.busiest).toEqual([]);
    expect(markdown).toContain("performed 0 actions on your behalf");
    expect(markdown).toContain("weighted assumptions, that represents an estimated ~0 hours saved");
    expect(markdown).toContain("| Auto-fixes applied | 0 |");
    expect(markdown).toContain("| Findings auto-cleared | 0 |");
    expect(markdown).toContain("Of these, 0 were findings auto-cleared (housekeeping, not counted toward the time-saved estimate).");
    expect(markdown).toContain("## Time-saved assumptions");
    expect(markdown).toContain("- Reports generated: 15 minutes");
    expect(markdown.toLowerCase()).not.toContain("not configured");
  });

  test("reports not configured only when the action audit source is absent", async () => {
    db().exec("DROP TABLE action_audit");
    const periodEnd = Date.UTC(2026, 6, 13, 7);
    const stats = await withTenant(() => collectSystemLaborStats(periodEnd - 7 * DAY_MS, periodEnd));

    expect(stats).toEqual({ configured: false });
    expect(renderSystemLaborReport(stats, { start: periodEnd - 7 * DAY_MS, end: periodEnd }))
      .toContain("Not configured: action_audit is unavailable.");
  });

  test("waits for Monday 07:00, generates once, persists rows, and force bypasses", async () => {
    const reference = Date.UTC(2026, 6, 8, 12);
    const { mondayStart } = mondayWindow(reference);
    const before = mondayStart + 6 * 60 * 60 * 1000;
    const after = mondayStart + 8 * 60 * 60 * 1000;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";

    await withTenant(async () => {
      expect(await maybeGenerateWeeklySystemLaborReport({ now: before })).toEqual({ generated: false, skipped: "before-window" });
      const first = await maybeGenerateWeeklySystemLaborReport({ now: after });
      expect(first.generated).toBe(true);
      expect(first.path).toBe(join(tempDir, "vault", "weekly", "2026-07-06-system-labor.md"));
      expect(first.path && existsSync(first.path)).toBe(true);
      expect(readFileSync(first.path!, "utf8")).toContain("# System Labor Report — 2026-W28");
      expect(await maybeGenerateWeeklySystemLaborReport({ now: after + 1_000 })).toEqual({ generated: false, skipped: "already-generated" });
      expect((await maybeGenerateWeeklySystemLaborReport({ force: true, now: after + 2_000 })).generated).toBe(true);
    });

    const archive = db().query("SELECT kind, path FROM report_archive WHERE kind = ? ORDER BY id")
      .all(WEEKLY_SYSTEM_LABOR_KIND) as Array<{ kind: string; path: string }>;
    expect(archive).toHaveLength(2);
    expect(archive[0]).toEqual({ kind: WEEKLY_SYSTEM_LABOR_KIND, path: "weekly/2026-07-06-system-labor.md" });
    expect((db().query("SELECT COUNT(*) AS count FROM report_runs WHERE template_id = ?")
      .get(WEEKLY_SYSTEM_LABOR_KIND) as { count: number }).count).toBe(2);
    expect((db().query("SELECT COUNT(*) AS count FROM action_audit WHERE action_kind = 'reports.system-labor'")
      .get() as { count: number }).count).toBe(2);
  });

  test("direct force generation stays inside the injected vault", async () => {
    const result = await withTenant(() => generateWeeklySystemLaborReport({ force: true, now: Date.UTC(2026, 6, 6, 8) }));
    expect(result.path?.startsWith(join(tempDir, "vault"))).toBe(true);
  });
});
