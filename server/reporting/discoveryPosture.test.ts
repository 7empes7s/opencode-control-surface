import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { getTenantContext } from "../tenancy/context.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { mondayWindow } from "./executive.ts";
import {
  collectDiscoveryPostureStats,
  generateWeeklyDiscoveryPostureReport,
  maybeGenerateWeeklyDiscoveryPostureReport,
  renderDiscoveryPostureReport,
  WEEKLY_DISCOVERY_POSTURE_KIND,
} from "./discoveryPosture.ts";

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
  tempDir = mkdtempSync(join(tmpdir(), "discovery-posture-test-"));
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

function insertAsset(input: {
  id: string;
  kind: string;
  sourceProbe: string;
  firstSeen: number;
  updatedAt: number;
  status: "registered" | "unregistered" | "ignored";
  criticality?: "critical" | "high" | "medium" | "low" | null;
  tenantId?: string;
}): void {
  db().query(`INSERT INTO discovered_assets
    (id, tenant_id, kind, signature, source_probe, first_seen, last_seen, status, fingerprint_json, criticality, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`)
    .run(input.id, input.tenantId ?? "mimule", input.kind, `signature-${input.id}`, input.sourceProbe,
      input.firstSeen, input.updatedAt, input.status, input.criticality ?? null, input.updatedAt);
}

describe("weekly discovery posture report", () => {
  test("collects current posture, period movement, coverage, kinds, and source breadth", async () => {
    const periodStart = Date.UTC(2026, 6, 6);
    const periodEnd = periodStart + 7 * DAY_MS;
    insertAsset({ id: "r-critical", kind: "service", sourceProbe: "systemd", firstSeen: periodStart - DAY_MS, updatedAt: periodStart + 1, status: "registered", criticality: "critical" });
    insertAsset({ id: "r-high", kind: "service", sourceProbe: "systemd", firstSeen: periodStart + 1, updatedAt: periodStart + 2, status: "registered", criticality: "high" });
    insertAsset({ id: "r-medium", kind: "container", sourceProbe: "docker", firstSeen: periodStart - DAY_MS, updatedAt: periodStart - 1, status: "registered", criticality: "medium" });
    insertAsset({ id: "r-low", kind: "timer", sourceProbe: "systemd", firstSeen: periodStart - DAY_MS, updatedAt: periodStart - 1, status: "registered", criticality: "low" });
    insertAsset({ id: "r-null", kind: "container", sourceProbe: "docker", firstSeen: periodStart + 3, updatedAt: periodStart + 4, status: "registered", criticality: null });
    insertAsset({ id: "u-new-one", kind: "container", sourceProbe: "docker", firstSeen: periodStart + 5, updatedAt: periodStart + 5, status: "unregistered" });
    insertAsset({ id: "u-new-two", kind: "service", sourceProbe: "systemd", firstSeen: periodEnd - 1, updatedAt: periodEnd - 1, status: "unregistered" });
    insertAsset({ id: "u-old", kind: "port", sourceProbe: "socket", firstSeen: periodStart - 1, updatedAt: periodStart + 6, status: "unregistered" });
    insertAsset({ id: "ignored", kind: "timer", sourceProbe: "systemd", firstSeen: periodStart + 7, updatedAt: periodStart + 7, status: "ignored" });
    insertAsset({ id: "end-exclusive", kind: "service", sourceProbe: "systemd", firstSeen: periodEnd, updatedAt: periodEnd, status: "unregistered" });
    insertAsset({ id: "other", kind: "service", sourceProbe: "systemd", firstSeen: periodStart + 1, updatedAt: periodStart + 1, status: "unregistered", tenantId: "another-tenant" });

    const stats = await withTenant(() => collectDiscoveryPostureStats(periodStart, periodEnd));
    expect(stats.configured).toBe(true);
    if (!stats.configured) throw new Error("discovery posture source unavailable");
    expect(stats.totals).toEqual({ registered: 5, unregistered: 4, ignored: 1, total: 10 });
    expect(stats.newThisPeriod).toEqual({
      count: 5,
      byKind: [
        { kind: "container", count: 2 },
        { kind: "service", count: 2 },
        { kind: "timer", count: 1 },
      ],
    });
    expect(stats.registeredThisPeriod).toBe(3);
    expect(stats.stillUnregisteredNew).toBe(2);
    expect(stats.criticalityCoverage).toEqual({
      coveredCount: 4,
      uncoveredCount: 1,
      coveragePercent: 80,
      breakdown: { critical: 1, high: 1, medium: 1, low: 1 },
    });
    expect(stats.bySourceProbe).toEqual([
      { sourceProbe: "systemd", count: 6 },
      { sourceProbe: "docker", count: 3 },
      { sourceProbe: "socket", count: 1 },
    ]);

    const markdown = renderDiscoveryPostureReport(stats, { start: periodStart, end: periodEnd });
    expect(markdown).toContain("# Discovery Posture Report — 2026-W29");
    expect(markdown).toContain("10 assets discovered; 4 unregistered (governance gap); 80% of registered assets have a criticality assigned.");
    expect(markdown).toContain("+2 new gaps, −3 triaged this period. This is period activity, not a stored snapshot delta.");
    expect(markdown).toContain("4 covered / 1 unassigned (80%).");
    expect(markdown).toContain("- systemd: 6");
  });

  test("renders configured emptiness as zeros and missing source as not configured", async () => {
    const periodEnd = Date.UTC(2026, 6, 13, 7);
    const period = { start: periodEnd - 7 * DAY_MS, end: periodEnd };
    const empty = await withTenant(() => collectDiscoveryPostureStats(period.start, period.end));
    expect(empty.configured).toBe(true);
    const emptyMarkdown = renderDiscoveryPostureReport(empty, period);
    expect(emptyMarkdown).toContain("0 assets discovered; 0 unregistered (governance gap); not applicable (no registered assets) of registered assets have a criticality assigned.");
    expect(emptyMarkdown).toContain("0 new assets.");
    expect(emptyMarkdown).toContain("+0 new gaps, −0 triaged this period.");
    expect(emptyMarkdown).not.toContain("Not configured");

    db().exec("DROP TABLE discovered_assets");
    const missing = await withTenant(() => collectDiscoveryPostureStats(period.start, period.end));
    expect(missing).toEqual({ configured: false });
    expect(renderDiscoveryPostureReport(missing, period)).toContain("Not configured: discovered_assets is unavailable.");
  });

  test("waits for Monday 07:00, generates once, persists rows, and force bypasses", async () => {
    const reference = Date.UTC(2026, 6, 8, 12);
    const { mondayStart } = mondayWindow(reference);
    const before = mondayStart + 6 * 60 * 60 * 1000;
    const after = mondayStart + 8 * 60 * 60 * 1000;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";

    await withTenant(async () => {
      expect(await maybeGenerateWeeklyDiscoveryPostureReport({ now: before })).toEqual({ generated: false, skipped: "before-window" });
      const first = await maybeGenerateWeeklyDiscoveryPostureReport({ now: after });
      expect(first.generated).toBe(true);
      expect(first.path).toBe(join(tempDir, "vault", "weekly", "2026-07-06-discovery-posture.md"));
      expect(first.path && existsSync(first.path)).toBe(true);
      expect(readFileSync(first.path!, "utf8")).toContain("# Discovery Posture Report — 2026-W28");
      expect(await maybeGenerateWeeklyDiscoveryPostureReport({ now: after + 1_000 })).toEqual({ generated: false, skipped: "already-generated" });
      expect((await maybeGenerateWeeklyDiscoveryPostureReport({ force: true, now: after + 2_000 })).generated).toBe(true);
    });

    const archive = db().query("SELECT kind, path FROM report_archive WHERE kind = ? ORDER BY id")
      .all(WEEKLY_DISCOVERY_POSTURE_KIND) as Array<{ kind: string; path: string }>;
    expect(archive).toHaveLength(2);
    expect(archive[0]).toEqual({ kind: WEEKLY_DISCOVERY_POSTURE_KIND, path: "weekly/2026-07-06-discovery-posture.md" });
    expect((db().query("SELECT COUNT(*) AS count FROM report_runs WHERE template_id = ?")
      .get(WEEKLY_DISCOVERY_POSTURE_KIND) as { count: number }).count).toBe(2);
    expect((db().query("SELECT COUNT(*) AS count FROM action_audit WHERE action_kind = 'reports.discovery-posture'")
      .get() as { count: number }).count).toBe(2);
  });

  test("direct force generation stays inside the injected vault", async () => {
    const result = await withTenant(() => generateWeeklyDiscoveryPostureReport({ force: true, now: Date.UTC(2026, 6, 6, 8) }));
    expect(result.path?.startsWith(join(tempDir, "vault"))).toBe(true);
  });
});
