import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { sendTelegramAlert } from "../notifications/telegram.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { isoWeek, mondayWindow } from "./executive.ts";

export const WEEKLY_SLA_UPTIME_KIND = "weekly-sla-uptime";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type Configured<T> = ({ configured: true } & T) | { configured: false };

export type SlaUptimeService = {
  service: string;
  upSamples: number;
  downSamples: number;
  uptimePercent: number;
  unmeasuredSamples: number;
};

export type SlaUptimeStatsValue = {
  services: SlaUptimeService[];
  noDataServices: string[];
  overall: { uptimePercent: number | null; upSamples: number; downSamples: number };
  breaches: { raised: number; resolved: number; openNow: number };
  nearMisses: { count: number; names: string[] };
};

export type SlaUptimeStats = Configured<SlaUptimeStatsValue>;
export type SlaUptimePeriod = { start: number; end: number };
export type WeeklySlaUptimeResult = { generated: boolean; path?: string; skipped?: "db-disabled" | "before-window" | "already-generated" };

type ServiceAggregate = { service: string; up_samples: number; down_samples: number; unmeasured_samples: number };
type BreachAggregate = { raised: number; resolved: number; open_now: number };

export function collectSlaUptimeStats(periodStart: number, periodEnd: number): SlaUptimeStats {
  const db = getDashboardDb();
  if (!db) return { configured: false };
  const source = db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'metric_samples'")
    .get() as { present: number } | null;
  if (!source) return { configured: false };

  const tenantId = getCurrentTenantContext().tenantId;
  const rows = db.query(`WITH service_states AS (
      SELECT substr(key, 1, length(key) - 6) AS service,
        CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.state') ELSE NULL END AS state
      FROM metric_samples
      WHERE source = 'services'
        AND key LIKE '%.state'
        AND ts >= ? AND ts < ?
        AND (tenant_id = ? OR tenant_id IS NULL)
    )
    SELECT service,
      SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS up_samples,
      SUM(CASE WHEN state = 'inactive' THEN 1 ELSE 0 END) AS down_samples,
      SUM(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END) AS unmeasured_samples
    FROM service_states
    GROUP BY service
    ORDER BY service`).all(periodStart, periodEnd, tenantId) as ServiceAggregate[];

  const services: SlaUptimeService[] = [];
  const noDataServices: string[] = [];
  for (const row of rows) {
    const measuredSamples = row.up_samples + row.down_samples;
    if (measuredSamples === 0) {
      noDataServices.push(row.service);
      continue;
    }
    services.push({
      service: row.service,
      upSamples: row.up_samples,
      downSamples: row.down_samples,
      uptimePercent: (row.up_samples / measuredSamples) * 100,
      unmeasuredSamples: row.unmeasured_samples,
    });
  }
  services.sort((a, b) => a.uptimePercent - b.uptimePercent || a.service.localeCompare(b.service));
  noDataServices.sort((a, b) => a.localeCompare(b));

  const upSamples = services.reduce((sum, service) => sum + service.upSamples, 0);
  const downSamples = services.reduce((sum, service) => sum + service.downSamples, 0);
  const measuredSamples = upSamples + downSamples;
  const nearMissNames = services
    .filter((service) => service.uptimePercent >= 90 && service.uptimePercent < 100)
    .map((service) => service.service);

  let breaches: SlaUptimeStatsValue["breaches"] = { raised: 0, resolved: 0, openNow: 0 };
  try {
    const breachRow = db.query(`SELECT
        SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS raised,
        SUM(CASE WHEN resolved_at >= ? AND resolved_at < ? THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_now
      FROM insights
      WHERE source_key LIKE 'ops:sla-breach:%'
        AND (tenant_id = ? OR tenant_id IS NULL)`)
      .get(periodStart, periodEnd, periodStart, periodEnd, tenantId) as BreachAggregate | null;
    breaches = {
      raised: breachRow?.raised ?? 0,
      resolved: breachRow?.resolved ?? 0,
      openNow: breachRow?.open_now ?? 0,
    };
  } catch {
    // Older databases may not have insights yet; the uptime source remains configured.
  }

  return {
    configured: true,
    services,
    noDataServices,
    overall: {
      uptimePercent: measuredSamples > 0 ? (upSamples / measuredSamples) * 100 : null,
      upSamples,
      downSamples,
    },
    breaches,
    nearMisses: { count: nearMissNames.length, names: nearMissNames },
  };
}

function percent(value: number): string {
  return `${value.toFixed(2)}%`;
}

export function renderSlaUptimeReport(stats: SlaUptimeStats, period: SlaUptimePeriod): string {
  const week = isoWeek(new Date(period.end));
  const lines = [
    `# SLA / Uptime Report — ${week.year}-W${String(week.week).padStart(2, "0")}`,
    "",
    `Period: ${new Date(period.start).toISOString()} — ${new Date(period.end).toISOString()}`,
    "",
    "## Fleet uptime",
  ];

  if (!stats.configured) {
    lines.push("Not configured: metric_samples is unavailable.");
  } else if (stats.overall.uptimePercent === null) {
    lines.push("No measured services this period.");
  } else {
    lines.push(`${percent(stats.overall.uptimePercent)} overall (${stats.overall.upSamples} up / ${stats.overall.downSamples} down samples; unknown samples excluded).`);
  }

  lines.push("", "## Per-service uptime");
  if (!stats.configured) {
    lines.push("Not configured: metric_samples is unavailable.");
  } else if (stats.services.length === 0) {
    lines.push("No measured services this period.");
  } else {
    lines.push("| Service | Uptime | Up | Down | Unmeasured |", "| --- | ---: | ---: | ---: | ---: |");
    stats.services.forEach((service) => {
      lines.push(`| ${service.service} | ${percent(service.uptimePercent)} | ${service.upSamples} | ${service.downSamples} | ${service.unmeasuredSamples} |`);
    });
  }

  lines.push("", "## SLA breaches");
  lines.push(stats.configured
    ? `${stats.breaches.raised} raised · ${stats.breaches.resolved} resolved · ${stats.breaches.openNow} open now.`
    : "Not configured: metric_samples is unavailable.");

  lines.push("", "## Near-miss watch list");
  if (!stats.configured) lines.push("Not configured: metric_samples is unavailable.");
  else if (stats.nearMisses.count === 0) lines.push("No near-misses (threshold: 90% ≤ uptime < 100%).");
  else lines.push(`${stats.nearMisses.count} near-miss${stats.nearMisses.count === 1 ? "" : "es"} (threshold: 90% ≤ uptime < 100%): ${stats.nearMisses.names.join(", ")}.`);

  lines.push("", "## No determinate data");
  if (!stats.configured) lines.push("Not configured: metric_samples is unavailable.");
  else if (stats.noDataServices.length === 0) lines.push("None.");
  else lines.push(`Monitored but no determinate state this period: ${stats.noDataServices.join(", ")}.`);
  return `${lines.join("\n")}\n`;
}

function reportRoot(): string {
  return process.env.DASHBOARD_AI_VAULT_DIR ?? process.env.DASHBOARD_REPORTS_VAULT_DIR ?? "/opt/ai-vault";
}

export async function generateWeeklySlaUptimeReport(opts: { force?: boolean; now?: number } = {}): Promise<WeeklySlaUptimeResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const gate = await maybeGenerateWeeklySlaUptimeReport({ now, generate: false });
    if (!gate.generated) return gate;
  }

  const period = { start: now - WEEK_MS, end: now };
  const stats = collectSlaUptimeStats(period.start, period.end);
  const markdown = renderSlaUptimeReport(stats, period);
  const tenantId = getCurrentTenantContext().tenantId;
  const date = new Date(now).toISOString().slice(0, 10);
  const relativePath = `weekly/${date}-sla-uptime.md`;
  const path = join(reportRoot(), relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf8");

  const db = getDashboardDb()!;
  db.query("INSERT INTO report_archive (ts, kind, path, summary) VALUES (?, ?, ?, ?)")
    .run(now, WEEKLY_SLA_UPTIME_KIND, relativePath, markdown);
  db.query(`INSERT OR REPLACE INTO report_runs
    (id, tenant_id, template_id, params_json, status, output_json, row_count, started_at, finished_at, error)
    VALUES (?, ?, ?, ?, 'success', ?, 1, ?, ?, NULL)`)
    .run(`weekly-sla-uptime-${tenantId}-${now}`, tenantId, WEEKLY_SLA_UPTIME_KIND,
      JSON.stringify({ fromTs: period.start, toTs: period.end }),
      JSON.stringify({ rows: [{ markdown }], rowCount: 1, generatedAt: now }), now, now);

  const week = isoWeek(new Date(now));
  const fleet = stats.configured && stats.overall.uptimePercent !== null ? percent(stats.overall.uptimePercent) : "no measured services";
  const worst = stats.configured && stats.services.length > 0
    ? `${stats.services[0].service} ${percent(stats.services[0].uptimePercent)}`
    : "none";
  const openBreaches = stats.configured ? stats.breaches.openNow : 0;
  const telegram = [
    `SLA / Uptime Report — ${week.year}-W${String(week.week).padStart(2, "0")}`,
    `Fleet uptime: ${fleet} · Worst service: ${worst} · Open breaches: ${openBreaches}`,
    "Full report on /reports",
  ].join("\n");
  let sent = false;
  try { sent = await sendTelegramAlert(telegram); } catch (error) { console.error("[sla-uptime] telegram send threw", error); }
  try {
    writeActionAudit({ actionKind: "reports.sla-uptime", actor: "system", actorSource: "scheduler", target: WEEKLY_SLA_UPTIME_KIND,
      targetType: "report", result: sent ? "sent" : "generated", resultStatus: "success", resultJson: { path, sent, stats } });
  } catch (error) { console.error("[sla-uptime] audit write failed", error); }
  return { generated: true, path };
}

export async function maybeGenerateWeeklySlaUptimeReport(opts: { force?: boolean; now?: number; generate?: boolean } = {}): Promise<WeeklySlaUptimeResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  const { mondayStart, scheduledAt } = mondayWindow(now);
  if (!opts.force && now < scheduledAt) return { generated: false, skipped: "before-window" };
  const row = getDashboardDb()!.query(`SELECT COUNT(*) AS count FROM report_archive
    WHERE kind = ? AND ts >= ? AND ts < ?`).get(WEEKLY_SLA_UPTIME_KIND, mondayStart, mondayStart + WEEK_MS) as { count: number } | null;
  if (!opts.force && (row?.count ?? 0) > 0) return { generated: false, skipped: "already-generated" };
  if (opts.generate === false) return { generated: true };
  return generateWeeklySlaUptimeReport({ force: true, now });
}
