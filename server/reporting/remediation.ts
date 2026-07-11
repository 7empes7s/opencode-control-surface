import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { sendTelegramAlert } from "../notifications/telegram.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

export const MONTHLY_REMEDIATION_KIND = "monthly-remediation";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PERIOD_MS = 4 * WEEK_MS;
const BLOCKS = "▁▂▃▄▅▆▇█";

export type Configured<T> = ({ configured: true } & T) | { configured: false };

export type RemediationBucket = {
  start: number;
  end: number;
  resolved: number;
  autoRemediated: number;
  autoShare: number | null;
  mttrMs: number | null;
};

export type RemediationTotals = {
  resolved: number;
  autoRemediated: number;
  autoShare: number | null;
  mttrMs: number | null;
};

export type RemediationStats = {
  loopTrend: Configured<{ buckets: RemediationBucket[]; overall: RemediationTotals }>;
  recurrence: Configured<{ raised: number; cleared: number; openNow: number }>;
  topFlappers: Configured<{ flappers: Array<{ title: string; failureClass: string; occurrenceCount: number; status: string }> }>;
};

export type RemediationPeriod = { start: number; end: number };
export type MonthlyRemediationResult = { generated: boolean; path?: string; skipped?: "db-disabled" | "before-window" | "already-generated" };

type LoopRow = { resolved: number | null; auto_remediated: number | null; mttr_ms: number | null };

function collectLoopRow(start: number, end: number, tenantId: string): RemediationTotals {
  const db = getDashboardDb()!;
  const row = db.query(`SELECT
    COUNT(*) AS resolved,
    SUM(CASE WHEN EXISTS (
      SELECT 1 FROM action_audit AS audit
      WHERE (audit.tenant_id = ? OR audit.tenant_id IS NULL)
        AND audit.target_id = incident.id
        AND audit.action_kind IN ('incidents.auto-close', 'incidents.auto-resolve')
        AND audit.result_status = 'success'
    ) THEN 1 ELSE 0 END) AS auto_remediated,
    AVG(CASE WHEN incident.first_seen >= ? AND incident.first_seen < ?
      THEN MAX(0, incident.resolved_at - incident.first_seen) END) AS mttr_ms
    FROM reasoner_incidents AS incident
    WHERE (incident.tenant_id = ? OR incident.tenant_id IS NULL)
      AND incident.resolved_at >= ? AND incident.resolved_at < ?`)
    .get(tenantId, start, end, tenantId, start, end) as LoopRow | null;
  const resolved = row?.resolved ?? 0;
  const autoRemediated = row?.auto_remediated ?? 0;
  return {
    resolved,
    autoRemediated,
    autoShare: resolved > 0 ? autoRemediated / resolved : null,
    mttrMs: row?.mttr_ms ?? null,
  };
}

export function collectRemediationStats(periodStart: number, periodEnd: number): RemediationStats {
  const db = getDashboardDb();
  const tenantId = getCurrentTenantContext().tenantId;
  if (!db) {
    return { loopTrend: { configured: false }, recurrence: { configured: false }, topFlappers: { configured: false } };
  }

  let loopTrend: RemediationStats["loopTrend"] = { configured: false };
  let recurrence: RemediationStats["recurrence"] = { configured: false };
  let topFlappers: RemediationStats["topFlappers"] = { configured: false };

  try {
    const buckets: RemediationBucket[] = [];
    for (let start = periodStart; start < periodEnd && buckets.length < 4; start += WEEK_MS) {
      const end = Math.min(start + WEEK_MS, periodEnd);
      buckets.push({ start, end, ...collectLoopRow(start, end, tenantId) });
    }
    loopTrend = { configured: true, buckets, overall: collectLoopRow(periodStart, periodEnd, tenantId) };
  } catch {
    loopTrend = { configured: false };
  }

  try {
    const row = db.query(`SELECT
      SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS raised,
      SUM(CASE WHEN resolved_at >= ? AND resolved_at < ? THEN 1 ELSE 0 END) AS cleared,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_now
      FROM insights
      WHERE source_key LIKE 'remediation:recurrence:%'
        AND (tenant_id = ? OR tenant_id IS NULL)`)
      .get(periodStart, periodEnd, periodStart, periodEnd, tenantId) as { raised: number | null; cleared: number | null; open_now: number | null } | null;
    recurrence = { configured: true, raised: row?.raised ?? 0, cleared: row?.cleared ?? 0, openNow: row?.open_now ?? 0 };
  } catch {
    recurrence = { configured: false };
  }

  try {
    const rows = db.query(`SELECT title, failure_class, occurrence_count, status
      FROM reasoner_incidents
      WHERE (tenant_id = ? OR tenant_id IS NULL) AND last_seen >= ? AND last_seen < ?
      ORDER BY occurrence_count DESC, last_seen DESC, id ASC LIMIT 5`)
      .all(tenantId, periodStart, periodEnd) as Array<{ title: string; failure_class: string; occurrence_count: number; status: string }>;
    topFlappers = { configured: true, flappers: rows.map((row) => ({
      title: row.title,
      failureClass: row.failure_class,
      occurrenceCount: row.occurrence_count,
      status: row.status,
    })) };
  } catch {
    topFlappers = { configured: false };
  }

  return { loopTrend, recurrence, topFlappers };
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function percent(value: number | null): string {
  return value === null ? "insufficient data" : `${Math.round(value * 100)}%`;
}

function autoShareSparkline(buckets: RemediationBucket[]): string {
  const values = buckets.map((bucket) => bucket.autoShare).filter((value): value is number => value !== null);
  if (values.length === 0) return "insufficient data";
  const min = Math.min(...values);
  const max = Math.max(...values);
  return buckets.map((bucket) => {
    if (bucket.autoShare === null) return "·";
    if (min === max) return BLOCKS[3];
    return BLOCKS[Math.round(((bucket.autoShare - min) / (max - min)) * (BLOCKS.length - 1))];
  }).join("");
}

export function renderRemediationReport(stats: RemediationStats, period: RemediationPeriod): string {
  const month = new Date(period.end).toISOString().slice(0, 7);
  const lines = [
    `# Remediation Loop Report — ${month}`,
    "",
    `Period: ${new Date(period.start).toISOString()} — ${new Date(period.end).toISOString()}`,
    "",
    "## Loop trend",
  ];

  if (!stats.loopTrend.configured) {
    lines.push("Not configured: remediation-loop data is unavailable.");
  } else {
    lines.push("| Week | Resolved | Auto | Share | MTTR |", "| --- | ---: | ---: | ---: | ---: |");
    stats.loopTrend.buckets.forEach((bucket, index) => {
      lines.push(`| ${index + 1} (${new Date(bucket.start).toISOString().slice(0, 10)}) | ${bucket.resolved} | ${bucket.autoRemediated} | ${percent(bucket.autoShare)} | ${bucket.mttrMs === null ? "insufficient data" : duration(bucket.mttrMs)} |`);
    });
    const overall = stats.loopTrend.overall;
    lines.push(`| **Period** | **${overall.resolved}** | **${overall.autoRemediated}** | **${percent(overall.autoShare)}** | **${overall.mttrMs === null ? "insufficient data" : duration(overall.mttrMs)}** |`);
    lines.push("", `Auto-remediation share trend: ${autoShareSparkline(stats.loopTrend.buckets)}`);
  }

  lines.push("", "## Recurrence flags");
  lines.push(stats.recurrence.configured
    ? `${stats.recurrence.raised} raised · ${stats.recurrence.cleared} cleared · ${stats.recurrence.openNow} open now`
    : "Not configured: recurrence insight data is unavailable.");

  lines.push("", "## Top flappers");
  if (!stats.topFlappers.configured) lines.push("Not configured: incident flapper data is unavailable.");
  else if (stats.topFlappers.flappers.length === 0) lines.push("No flappers this period.");
  else stats.topFlappers.flappers.forEach((flapper, index) => {
    lines.push(`${index + 1}. **${flapper.title}** — ${flapper.failureClass} · ${flapper.occurrenceCount} occurrences · ${flapper.status}`);
  });

  return `${lines.join("\n")}\n`;
}

export function currentMonthWindow(now: number): { monthStart: number; scheduledAt: number; monthEnd: number } {
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return {
    monthStart,
    scheduledAt: monthStart + 7 * 60 * 60 * 1000,
    monthEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

function reportRoot(): string {
  return process.env.DASHBOARD_AI_VAULT_DIR ?? process.env.DASHBOARD_REPORTS_VAULT_DIR ?? "/opt/ai-vault";
}

function mttrTrendDirection(buckets: RemediationBucket[]): string {
  const values = buckets.map((bucket) => bucket.mttrMs).filter((value): value is number => value !== null);
  if (values.length < 2) return "insufficient data";
  if (values.at(-1)! < values[0]) return "improving";
  if (values.at(-1)! > values[0]) return "worsening";
  return "flat";
}

export async function generateMonthlyRemediationReport(opts: { force?: boolean; now?: number } = {}): Promise<MonthlyRemediationResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const gate = await maybeGenerateMonthlyRemediationReport({ now, generate: false });
    if (!gate.generated) return gate;
  }

  const period = { start: now - PERIOD_MS, end: now };
  const stats = collectRemediationStats(period.start, period.end);
  const markdown = renderRemediationReport(stats, period);
  const tenantId = getCurrentTenantContext().tenantId;
  const month = new Date(now).toISOString().slice(0, 7);
  const relativePath = `monthly/${month}-remediation.md`;
  const path = join(reportRoot(), relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf8");

  const db = getDashboardDb()!;
  db.query(`INSERT INTO report_archive (ts, kind, path, summary) VALUES (?, ?, ?, ?)`)
    .run(now, MONTHLY_REMEDIATION_KIND, relativePath, markdown);
  db.query(`INSERT OR REPLACE INTO report_runs
    (id, tenant_id, template_id, params_json, status, output_json, row_count, started_at, finished_at, error)
    VALUES (?, ?, ?, ?, 'success', ?, 1, ?, ?, NULL)`)
    .run(`monthly-remediation-${tenantId}-${now}`, tenantId, MONTHLY_REMEDIATION_KIND,
      JSON.stringify({ fromTs: period.start, toTs: period.end }), JSON.stringify({ rows: [{ markdown }], rowCount: 1, generatedAt: now }), now, now);

  const overall = stats.loopTrend.configured ? stats.loopTrend.overall : null;
  const flapperCount = stats.topFlappers.configured ? stats.topFlappers.flappers.length : null;
  const telegram = [
    `Monthly Remediation Report — ${month}`,
    `Auto-remediated share: ${overall ? percent(overall.autoShare) : "not configured"} · MTTR trend: ${stats.loopTrend.configured ? mttrTrendDirection(stats.loopTrend.buckets) : "not configured"}`,
    `Top flappers: ${flapperCount ?? "not configured"} · Full report on /reports`,
  ].join("\n");
  let sent = false;
  try { sent = await sendTelegramAlert(telegram); } catch (error) { console.error("[remediation] telegram send threw", error); }
  try {
    writeActionAudit({ actionKind: "reports.remediation", actor: "system", actorSource: "scheduler", target: MONTHLY_REMEDIATION_KIND,
      targetType: "report", result: sent ? "sent" : "generated", resultStatus: "success", resultJson: { path, sent, stats } });
  } catch (error) { console.error("[remediation] audit write failed", error); }
  return { generated: true, path };
}

export async function maybeGenerateMonthlyRemediationReport(opts: { force?: boolean; now?: number; generate?: boolean } = {}): Promise<MonthlyRemediationResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  const { monthStart, scheduledAt, monthEnd } = currentMonthWindow(now);
  if (!opts.force && now < scheduledAt) return { generated: false, skipped: "before-window" };
  const row = getDashboardDb()!.query(`SELECT COUNT(*) AS count FROM report_archive
    WHERE kind = ? AND ts >= ? AND ts < ?`).get(MONTHLY_REMEDIATION_KIND, monthStart, monthEnd) as { count: number } | null;
  if (!opts.force && (row?.count ?? 0) > 0) return { generated: false, skipped: "already-generated" };
  if (opts.generate === false) return { generated: true };
  return generateMonthlyRemediationReport({ force: true, now });
}
