import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { computeTrustScore, getTrustScoreHistory } from "../security/score.ts";
import { computeCostHeadline } from "../api/cost.ts";
import { MTTX_SAMPLE_WINDOW_MS } from "../api/incidents.ts";
import { newsBitesDeployAvailable } from "../api/actions.ts";
import { sendTelegramAlert } from "../notifications/telegram.ts";
import { writeActionAudit } from "../db/writer.ts";

export const WEEKLY_EXECUTIVE_KIND = "weekly-executive";
export const MODEL_HEALTH_FRESH_MS = 6 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BLOCKS = "▁▂▃▄▅▆▇█";

type Configured<T> = ({ configured: true } & T) | { configured: false };

export type ExecutiveStats = {
  healthScore: Configured<{ current: number; history: number[]; delta: number | null; sparkline: string }>;
  incidents: Configured<{ opened: number; closed: number; autoRemediated: number; autoRemediatedShare: number | null; mttrMs: number | null }>;
  cost: Configured<{ monthToDateCents: number; projectedMonthEndCents: number | null; savedByFreeFirstCents: number | null }>;
  modelAvailability: Configured<{ healthy: number; total: number; percent: number; checkedAt: number }>;
  deploys: Configured<{ count: number }>;
  contentPublished: Configured<{ count: number }>;
  topRisks: Configured<{ risks: Array<{ severity: string; title: string; actionId: string | null; actionLabel: string | null }> }>;
};

export type ExecutivePeriod = { start: number; end: number };
export type WeeklyExecutiveResult = { generated: boolean; path?: string; skipped?: "db-disabled" | "before-window" | "already-generated" };

type CountRow = { count: number };
type IncidentAggregate = { opened: number; closed: number; mttr_ms: number | null };
type MetricRow = { ts: number; value_json: string };

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => BLOCKS[3]).join("");
  return values.map((value) => BLOCKS[Math.round(((value - min) / (max - min)) * (BLOCKS.length - 1))]).join("");
}

function safeCount(sql: string, params: Array<string | number>): number {
  const db = getDashboardDb();
  if (!db) return 0;
  try {
    return (db.query(sql).get(...params) as CountRow | null)?.count ?? 0;
  } catch {
    return 0;
  }
}

function readPublishedTotal(row: MetricRow | null): number | null {
  if (!row) return null;
  try {
    const value = JSON.parse(row.value_json) as { totalPublished?: unknown };
    return typeof value.totalPublished === "number" && Number.isFinite(value.totalPublished) ? value.totalPublished : null;
  } catch {
    return null;
  }
}

function collectContentPublished(periodStart: number, periodEnd: number, tenantId: string): ExecutiveStats["contentPublished"] {
  const db = getDashboardDb();
  if (!db) return { configured: false };
  try {
    const endRow = db.query(`SELECT ts, value_json FROM metric_samples
      WHERE tenant_id = ? AND source = 'newsbites' AND key = 'published' AND ts <= ?
      ORDER BY ts DESC LIMIT 1`).get(tenantId, periodEnd) as MetricRow | null;
    const startRow = db.query(`SELECT ts, value_json FROM metric_samples
      WHERE tenant_id = ? AND source = 'newsbites' AND key = 'published' AND ts <= ?
      ORDER BY ts DESC LIMIT 1`).get(tenantId, periodStart) as MetricRow | null;
    const endTotal = readPublishedTotal(endRow);
    const startTotal = readPublishedTotal(startRow);
    if (endTotal === null || startTotal === null) return { configured: false };
    return { configured: true, count: Math.max(0, endTotal - startTotal) };
  } catch {
    return { configured: false };
  }
}

function collectModelAvailability(now: number): ExecutiveStats["modelAvailability"] {
  const path = process.env.DASHBOARD_MODEL_HEALTH_PATH || "/var/lib/mimule/model-health.json";
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { lastFullCheckAt?: unknown; models?: Array<{ available?: unknown; error?: unknown }> };
    const fileMtime = statSync(path).mtimeMs;
    const checkedAt = typeof value.lastFullCheckAt === "number" ? value.lastFullCheckAt : fileMtime;
    if (now - checkedAt > MODEL_HEALTH_FRESH_MS || !Array.isArray(value.models) || value.models.length === 0) return { configured: false };
    const healthy = value.models.filter((model) => model.available === true && !model.error).length;
    return { configured: true, healthy, total: value.models.length, percent: (healthy / value.models.length) * 100, checkedAt };
  } catch {
    return { configured: false };
  }
}

function actionLabel(actionId: string | null): string | null {
  if (!actionId) return null;
  return actionId.split(":").join(" ");
}

export function collectExecutiveStats(periodStart: number, periodEnd: number): ExecutiveStats {
  const db = getDashboardDb();
  const tenantId = getCurrentTenantContext().tenantId;
  const score = computeTrustScore().score;
  const scoreHistory = getTrustScoreHistory(7).filter((row) => row.ts <= periodEnd).map((row) => row.score);
  const history = [...scoreHistory, score].slice(-8);
  const headline = computeCostHeadline(periodEnd);

  let incidents: ExecutiveStats["incidents"] = { configured: false };
  let topRisks: ExecutiveStats["topRisks"] = { configured: false };
  if (db) {
    try {
      const mttrStart = Math.max(periodStart, periodEnd - MTTX_SAMPLE_WINDOW_MS);
      const row = db.query(`SELECT
        SUM(CASE WHEN first_seen >= ? AND first_seen <= ? THEN 1 ELSE 0 END) AS opened,
        SUM(CASE WHEN resolved_at >= ? AND resolved_at <= ? THEN 1 ELSE 0 END) AS closed,
        AVG(CASE WHEN first_seen >= ? AND resolved_at >= ? AND resolved_at <= ?
          THEN MAX(0, resolved_at - first_seen) END) AS mttr_ms
        FROM reasoner_incidents WHERE tenant_id = ? OR tenant_id IS NULL`)
        .get(periodStart, periodEnd, periodStart, periodEnd, mttrStart, mttrStart, periodEnd, tenantId) as IncidentAggregate | null;
      const autoRemediated = safeCount(`SELECT COUNT(DISTINCT target_id) AS count FROM action_audit
        WHERE (tenant_id = ? OR tenant_id IS NULL) AND action_kind IN ('incidents.auto-close', 'incidents.auto-resolve')
          AND result_status = 'success' AND ts >= ? AND ts <= ?`, [tenantId, periodStart, periodEnd]);
      const closed = row?.closed ?? 0;
      incidents = {
        configured: true,
        opened: row?.opened ?? 0,
        closed,
        autoRemediated,
        autoRemediatedShare: closed > 0 ? autoRemediated / closed : null,
        mttrMs: row?.mttr_ms ?? null,
      };
    } catch {
      incidents = { configured: false };
    }

    try {
      const rows = db.query(`SELECT severity, title, action_descriptor_id FROM insights
        WHERE tenant_id = ? AND status = 'open'
        ORDER BY CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END DESC,
          created_at DESC LIMIT 3`).all(tenantId) as Array<{ severity: string; title: string; action_descriptor_id: string | null }>;
      topRisks = { configured: true, risks: rows.map((row) => ({
        severity: row.severity,
        title: row.title,
        actionId: row.action_descriptor_id,
        actionLabel: actionLabel(row.action_descriptor_id),
      })) };
    } catch {
      topRisks = { configured: false };
    }
  }

  return {
    healthScore: { configured: true, current: score, history, delta: history.length > 1 ? score - history[0] : null, sparkline: sparkline(history) },
    incidents,
    cost: headline.monthToDateCents === null ? { configured: false } : {
      configured: true,
      monthToDateCents: headline.monthToDateCents,
      projectedMonthEndCents: headline.projectedMonthEndCents,
      savedByFreeFirstCents: headline.savedVsPaidBaselineCents,
    },
    modelAvailability: collectModelAvailability(periodEnd),
    deploys: newsBitesDeployAvailable() ? {
      configured: true,
      count: safeCount(`SELECT COUNT(*) AS count FROM jobs WHERE kind = 'newsbites-deploy'
        AND state = 'success' AND finished_at >= ? AND finished_at <= ? AND (tenant_id = ? OR tenant_id IS NULL)`, [periodStart, periodEnd, tenantId]),
    } : { configured: false },
    contentPublished: collectContentPublished(periodStart, periodEnd, tenantId),
    topRisks,
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function isoWeek(date: Date): { year: number; week: number } {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return { year: target.getUTCFullYear(), week: Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7) };
}

export function mondayWindow(now: number): { mondayStart: number; scheduledAt: number } {
  const date = new Date(now);
  const day = date.getUTCDay() || 7;
  const mondayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1);
  return { mondayStart, scheduledAt: mondayStart + 7 * 60 * 60 * 1000 };
}

export function renderExecutiveReport(stats: ExecutiveStats, period: ExecutivePeriod): string {
  const week = isoWeek(new Date(period.end));
  const lines = [`# Weekly Executive Report — ${week.year}-W${String(week.week).padStart(2, "0")}`, "",
    `Period: ${new Date(period.start).toISOString()} — ${new Date(period.end).toISOString()}`, ""];
  lines.push("## Health score");
  lines.push(stats.healthScore.configured
    ? `${stats.healthScore.current}/100 · ${stats.healthScore.sparkline || "no history"} · ${stats.healthScore.delta === null ? "insufficient trend data" : `${stats.healthScore.delta >= 0 ? "+" : ""}${stats.healthScore.delta} over 7 days`}`
    : "Not configured: health-score source is unavailable.");
  lines.push("", "## Incidents");
  lines.push(stats.incidents.configured
    ? `${stats.incidents.opened} opened · ${stats.incidents.closed} closed · ${stats.incidents.autoRemediated} auto-remediated (${stats.incidents.autoRemediatedShare === null ? "share unavailable" : `${Math.round(stats.incidents.autoRemediatedShare * 100)}%`}) · MTTR ${stats.incidents.mttrMs === null ? "insufficient data" : duration(stats.incidents.mttrMs)}`
    : "Not configured: incident data is unavailable.");
  lines.push("", "## Cost");
  lines.push(stats.cost.configured
    ? `MTD ${money(stats.cost.monthToDateCents)} · projected month-end ${stats.cost.projectedMonthEndCents === null ? "insufficient data" : money(stats.cost.projectedMonthEndCents)} · saved by free-first ${stats.cost.savedByFreeFirstCents === null ? "no paid baseline configured" : money(stats.cost.savedByFreeFirstCents)}`
    : "Not configured: cost data is unavailable.");
  lines.push("", "## Model availability");
  lines.push(stats.modelAvailability.configured
    ? `${stats.modelAvailability.percent.toFixed(1)}% healthy (${stats.modelAvailability.healthy}/${stats.modelAvailability.total})`
    : "Not configured: model-health data is absent or stale.");
  lines.push("", "## Delivery");
  lines.push(stats.deploys.configured ? `Deploys shipped: ${stats.deploys.count}` : "Deploys shipped: not configured (deploy feature unavailable).");
  lines.push(stats.contentPublished.configured ? `Content published: ${stats.contentPublished.count}` : "Content published: not configured (no reliable ingested baseline).");
  lines.push("", "## Top open risks");
  if (!stats.topRisks.configured) lines.push("Not configured: insights data is unavailable.");
  else if (stats.topRisks.risks.length === 0) lines.push("No open risks.");
  else stats.topRisks.risks.forEach((risk, index) => lines.push(`${index + 1}. **${risk.severity.toUpperCase()}** — ${risk.title}${risk.actionId ? ` — Recommended action: ${risk.actionLabel} (${risk.actionId})` : " — Recommended action: not configured"}`));
  return `${lines.join("\n")}\n`;
}

function reportRoot(): string {
  return process.env.DASHBOARD_AI_VAULT_DIR ?? process.env.DASHBOARD_REPORTS_VAULT_DIR ?? "/opt/ai-vault";
}

export async function generateWeeklyExecutiveReport(opts: { force?: boolean; now?: number } = {}): Promise<WeeklyExecutiveResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const gate = await maybeGenerateWeeklyExecutiveReport({ now, generate: false });
    if (!gate.generated) return gate;
  }
  const period = { start: now - WEEK_MS, end: now };
  const stats = collectExecutiveStats(period.start, period.end);
  const markdown = renderExecutiveReport(stats, period);
  const tenantId = getCurrentTenantContext().tenantId;
  const date = new Date(now).toISOString().slice(0, 10);
  const path = join(reportRoot(), "weekly", `${date}-executive.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf8");
  const relativePath = `weekly/${date}-executive.md`;
  const db = getDashboardDb()!;
  db.query(`INSERT INTO report_archive (ts, kind, path, summary) VALUES (?, ?, ?, ?)`)
    .run(now, WEEKLY_EXECUTIVE_KIND, relativePath, markdown);
  db.query(`INSERT OR REPLACE INTO report_runs
    (id, tenant_id, template_id, params_json, status, output_json, row_count, started_at, finished_at, error)
    VALUES (?, ?, ?, ?, 'success', ?, 1, ?, ?, NULL)`)
    .run(`weekly-executive-${tenantId}-${now}`, tenantId, WEEKLY_EXECUTIVE_KIND,
      JSON.stringify({ fromTs: period.start, toTs: period.end }), JSON.stringify({ rows: [{ markdown }], rowCount: 1, generatedAt: now }), now, now);

  const telegram = [`Weekly Executive Report — ${isoWeek(new Date(now)).year}-W${String(isoWeek(new Date(now)).week).padStart(2, "0")}`,
    stats.healthScore.configured ? `Health ${stats.healthScore.current}/100 ${stats.healthScore.sparkline}` : "Health not configured",
    stats.incidents.configured ? `Incidents ${stats.incidents.opened} opened / ${stats.incidents.closed} closed` : "Incidents not configured",
    "Full report on /reports"].join("\n");
  let sent = false;
  try { sent = await sendTelegramAlert(telegram); } catch (error) { console.error("[executive] telegram send threw", error); }
  try {
    writeActionAudit({ actionKind: "reports.executive", actor: "system", actorSource: "scheduler", target: WEEKLY_EXECUTIVE_KIND,
      targetType: "report", result: sent ? "sent" : "generated", resultStatus: "success", resultJson: { path, sent, stats } });
  } catch (error) { console.error("[executive] audit write failed", error); }
  return { generated: true, path };
}

export async function maybeGenerateWeeklyExecutiveReport(opts: { force?: boolean; now?: number; generate?: boolean } = {}): Promise<WeeklyExecutiveResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  const { mondayStart, scheduledAt } = mondayWindow(now);
  if (!opts.force && now < scheduledAt) return { generated: false, skipped: "before-window" };
  const count = safeCount(`SELECT COUNT(*) AS count FROM report_archive WHERE kind = ? AND ts >= ? AND ts < ?`,
    [WEEKLY_EXECUTIVE_KIND, mondayStart, mondayStart + WEEK_MS]);
  if (!opts.force && count > 0) return { generated: false, skipped: "already-generated" };
  if (opts.generate === false) return { generated: true };
  return generateWeeklyExecutiveReport({ force: true, now });
}
