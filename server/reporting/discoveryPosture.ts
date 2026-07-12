import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { sendTelegramAlert } from "../notifications/telegram.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { isoWeek, mondayWindow } from "./executive.ts";

export const WEEKLY_DISCOVERY_POSTURE_KIND = "weekly-discovery-posture";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_KIND_COUNT = 5;

export type Configured<T> = ({ configured: true } & T) | { configured: false };

export type DiscoveryPostureStatsValue = {
  totals: { registered: number; unregistered: number; ignored: number; total: number };
  newThisPeriod: { count: number; byKind: Array<{ kind: string; count: number }> };
  registeredThisPeriod: number;
  stillUnregisteredNew: number;
  criticalityCoverage: {
    coveredCount: number;
    uncoveredCount: number;
    coveragePercent: number | null;
    breakdown: { critical: number; high: number; medium: number; low: number };
  };
  bySourceProbe: Array<{ sourceProbe: string; count: number }>;
};

export type DiscoveryPostureStats = Configured<DiscoveryPostureStatsValue>;
export type DiscoveryPosturePeriod = { start: number; end: number };
export type WeeklyDiscoveryPostureResult = {
  generated: boolean;
  path?: string;
  skipped?: "db-disabled" | "before-window" | "already-generated";
};

type PostureAggregate = {
  registered: number;
  unregistered: number;
  ignored: number;
  total: number;
  registered_this_period: number;
  still_unregistered_new: number;
  covered_count: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
};

export function collectDiscoveryPostureStats(periodStart: number, periodEnd: number): DiscoveryPostureStats {
  const db = getDashboardDb();
  if (!db) return { configured: false };
  const source = db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'discovered_assets'")
    .get() as { present: number } | null;
  if (!source) return { configured: false };

  const tenantId = getCurrentTenantContext().tenantId;
  const posture = db.query(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'registered' THEN 1 ELSE 0 END) AS registered,
      SUM(CASE WHEN status = 'unregistered' THEN 1 ELSE 0 END) AS unregistered,
      SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) AS ignored,
      SUM(CASE WHEN status = 'registered' AND updated_at >= ? AND updated_at < ? THEN 1 ELSE 0 END) AS registered_this_period,
      SUM(CASE WHEN status = 'unregistered' AND first_seen >= ? AND first_seen < ? THEN 1 ELSE 0 END) AS still_unregistered_new,
      SUM(CASE WHEN status = 'registered' AND criticality IS NOT NULL THEN 1 ELSE 0 END) AS covered_count,
      SUM(CASE WHEN status = 'registered' AND criticality = 'critical' THEN 1 ELSE 0 END) AS critical_count,
      SUM(CASE WHEN status = 'registered' AND criticality = 'high' THEN 1 ELSE 0 END) AS high_count,
      SUM(CASE WHEN status = 'registered' AND criticality = 'medium' THEN 1 ELSE 0 END) AS medium_count,
      SUM(CASE WHEN status = 'registered' AND criticality = 'low' THEN 1 ELSE 0 END) AS low_count
    FROM discovered_assets
    WHERE tenant_id = ?`).get(periodStart, periodEnd, periodStart, periodEnd, tenantId) as PostureAggregate;

  const newByKind = db.query(`SELECT kind, COUNT(*) AS count
    FROM discovered_assets
    WHERE tenant_id = ? AND first_seen >= ? AND first_seen < ?
    GROUP BY kind
    ORDER BY count DESC, kind ASC
    LIMIT ?`).all(tenantId, periodStart, periodEnd, TOP_KIND_COUNT) as Array<{ kind: string; count: number }>;
  const newCount = db.query(`SELECT COUNT(*) AS count FROM discovered_assets
    WHERE tenant_id = ? AND first_seen >= ? AND first_seen < ?`)
    .get(tenantId, periodStart, periodEnd) as { count: number };
  const sourceRows = db.query(`SELECT source_probe AS source_probe, COUNT(*) AS count
    FROM discovered_assets
    WHERE tenant_id = ?
    GROUP BY source_probe
    ORDER BY count DESC, source_probe ASC`).all(tenantId) as Array<{ source_probe: string; count: number }>;

  const registered = posture.registered ?? 0;
  const coveredCount = posture.covered_count ?? 0;
  return {
    configured: true,
    totals: {
      registered,
      unregistered: posture.unregistered ?? 0,
      ignored: posture.ignored ?? 0,
      total: posture.total ?? 0,
    },
    newThisPeriod: { count: newCount.count, byKind: newByKind },
    registeredThisPeriod: posture.registered_this_period ?? 0,
    stillUnregisteredNew: posture.still_unregistered_new ?? 0,
    criticalityCoverage: {
      coveredCount,
      uncoveredCount: registered - coveredCount,
      coveragePercent: registered > 0 ? (coveredCount / registered) * 100 : null,
      breakdown: {
        critical: posture.critical_count ?? 0,
        high: posture.high_count ?? 0,
        medium: posture.medium_count ?? 0,
        low: posture.low_count ?? 0,
      },
    },
    bySourceProbe: sourceRows.map((row) => ({ sourceProbe: row.source_probe, count: row.count })),
  };
}

function percent(value: number): string {
  return `${value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
}

function coverageLabel(stats: DiscoveryPostureStatsValue): string {
  return stats.criticalityCoverage.coveragePercent === null
    ? "not applicable (no registered assets)"
    : percent(stats.criticalityCoverage.coveragePercent);
}

export function renderDiscoveryPostureReport(stats: DiscoveryPostureStats, period: DiscoveryPosturePeriod): string {
  const week = isoWeek(new Date(period.end));
  const lines = [
    `# Discovery Posture Report — ${week.year}-W${String(week.week).padStart(2, "0")}`,
    "",
    `Period: ${new Date(period.start).toISOString()} — ${new Date(period.end).toISOString()}`,
    "",
  ];

  if (!stats.configured) {
    lines.push("Not configured: discovered_assets is unavailable.");
    return `${lines.join("\n")}\n`;
  }

  lines.push(`${stats.totals.total} assets discovered; ${stats.totals.unregistered} unregistered (governance gap); ${coverageLabel(stats)} of registered assets have a criticality assigned.`);
  lines.push(
    "",
    "## Current status",
    `- Registered: ${stats.totals.registered}`,
    `- Unregistered: ${stats.totals.unregistered}`,
    `- Ignored: ${stats.totals.ignored}`,
    `- Total: ${stats.totals.total}`,
    "",
    "## New this period",
  );
  if (stats.newThisPeriod.count === 0) {
    lines.push("0 new assets.");
  } else {
    lines.push(`${stats.newThisPeriod.count} new assets.`);
    stats.newThisPeriod.byKind.forEach((row) => lines.push(`- ${row.kind}: ${row.count}`));
  }
  lines.push(
    "",
    "## Period movement",
    `+${stats.stillUnregisteredNew} new gaps, −${stats.registeredThisPeriod} triaged this period. This is period activity, not a stored snapshot delta.`,
    "",
    "## Criticality coverage",
    `${stats.criticalityCoverage.coveredCount} covered / ${stats.criticalityCoverage.uncoveredCount} unassigned (${coverageLabel(stats)}).`,
    `- Critical: ${stats.criticalityCoverage.breakdown.critical}`,
    `- High: ${stats.criticalityCoverage.breakdown.high}`,
    `- Medium: ${stats.criticalityCoverage.breakdown.medium}`,
    `- Low: ${stats.criticalityCoverage.breakdown.low}`,
    "",
    "## Inventory by source probe",
  );
  if (stats.bySourceProbe.length === 0) lines.push("No assets surfaced by probes.");
  else stats.bySourceProbe.forEach((row) => lines.push(`- ${row.sourceProbe}: ${row.count}`));
  return `${lines.join("\n")}\n`;
}

function reportRoot(): string {
  return process.env.DASHBOARD_AI_VAULT_DIR ?? process.env.DASHBOARD_REPORTS_VAULT_DIR ?? "/opt/ai-vault";
}

export async function generateWeeklyDiscoveryPostureReport(opts: { force?: boolean; now?: number } = {}): Promise<WeeklyDiscoveryPostureResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const gate = await maybeGenerateWeeklyDiscoveryPostureReport({ now, generate: false });
    if (!gate.generated) return gate;
  }

  const period = { start: now - WEEK_MS, end: now };
  const stats = collectDiscoveryPostureStats(period.start, period.end);
  const markdown = renderDiscoveryPostureReport(stats, period);
  const tenantId = getCurrentTenantContext().tenantId;
  const date = new Date(now).toISOString().slice(0, 10);
  const relativePath = `weekly/${date}-discovery-posture.md`;
  const path = join(reportRoot(), relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf8");

  const db = getDashboardDb()!;
  db.query("INSERT INTO report_archive (ts, kind, path, summary) VALUES (?, ?, ?, ?)")
    .run(now, WEEKLY_DISCOVERY_POSTURE_KIND, relativePath, markdown);
  db.query(`INSERT OR REPLACE INTO report_runs
    (id, tenant_id, template_id, params_json, status, output_json, row_count, started_at, finished_at, error)
    VALUES (?, ?, ?, ?, 'success', ?, 1, ?, ?, NULL)`)
    .run(`weekly-discovery-posture-${tenantId}-${now}`, tenantId, WEEKLY_DISCOVERY_POSTURE_KIND,
      JSON.stringify({ fromTs: period.start, toTs: period.end }),
      JSON.stringify({ rows: [{ markdown }], rowCount: 1, generatedAt: now }), now, now);

  const week = isoWeek(new Date(now));
  const telegramStats = stats.configured
    ? `${stats.totals.total} discovered · ${stats.totals.unregistered} unregistered · ${coverageLabel(stats)} criticality coverage`
    : "Discovery inventory not configured";
  const telegram = [
    `Discovery Posture Report — ${week.year}-W${String(week.week).padStart(2, "0")}`,
    telegramStats,
    "Full report on /reports",
  ].join("\n");
  let sent = false;
  try { sent = await sendTelegramAlert(telegram); } catch (error) { console.error("[discovery-posture] telegram send threw", error); }
  try {
    writeActionAudit({ actionKind: "reports.discovery-posture", actor: "system", actorSource: "scheduler", target: WEEKLY_DISCOVERY_POSTURE_KIND,
      targetType: "report", result: sent ? "sent" : "generated", resultStatus: "success", resultJson: { path, sent, stats } });
  } catch (error) { console.error("[discovery-posture] audit write failed", error); }
  return { generated: true, path };
}

export async function maybeGenerateWeeklyDiscoveryPostureReport(opts: { force?: boolean; now?: number; generate?: boolean } = {}): Promise<WeeklyDiscoveryPostureResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  const { mondayStart, scheduledAt } = mondayWindow(now);
  if (!opts.force && now < scheduledAt) return { generated: false, skipped: "before-window" };
  const row = getDashboardDb()!.query(`SELECT COUNT(*) AS count FROM report_archive
    WHERE kind = ? AND ts >= ? AND ts < ?`).get(WEEKLY_DISCOVERY_POSTURE_KIND, mondayStart, mondayStart + WEEK_MS) as { count: number } | null;
  if (!opts.force && (row?.count ?? 0) > 0) return { generated: false, skipped: "already-generated" };
  if (opts.generate === false) return { generated: true };
  return generateWeeklyDiscoveryPostureReport({ force: true, now });
}
