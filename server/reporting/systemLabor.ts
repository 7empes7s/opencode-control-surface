import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { sendTelegramAlert } from "../notifications/telegram.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { isoWeek, mondayWindow } from "./executive.ts";

export const WEEKLY_SYSTEM_LABOR_KIND = "weekly-system-labor";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type Configured<T> = ({ configured: true } & T) | { configured: false };

type CategoryKey = "auto-fixes" | "probes-scans" | "reports" | "deploys" | "routing-chains" | "pipeline";

type CategoryDefinition = {
  key: CategoryKey;
  label: string;
  perActionMinutes: number;
  sql: string;
};

// SQL CASE uses this order, so a row matching more than one rule is assigned only
// to its first category. Keep matching and estimate assumptions together here.
export const SYSTEM_LABOR_CATEGORIES: readonly CategoryDefinition[] = [
  {
    key: "auto-fixes",
    label: "Auto-fixes applied",
    perActionMinutes: 5,
    sql: "action_kind LIKE 'insights.auto-%' OR action_kind LIKE 'incidents.auto-close' OR action_kind LIKE 'incidents.auto-resolve'",
  },
  {
    key: "probes-scans",
    label: "Probes & scans run",
    perActionMinutes: 2,
    sql: "action_kind LIKE 'scan:%' OR action_kind LIKE 'probe:%' OR actor_source = 'sentinel-scan'",
  },
  {
    key: "reports",
    label: "Reports generated",
    perActionMinutes: 15,
    sql: "action_kind LIKE 'reports.%'",
  },
  {
    key: "deploys",
    label: "Deploys run",
    perActionMinutes: 10,
    sql: "action_kind LIKE 'run.newsbites' OR action_kind LIKE 'run:newsbites:deploy'",
  },
  {
    key: "routing-chains",
    label: "Routing/chain actions",
    perActionMinutes: 5,
    sql: "action_kind LIKE 'start-job:gateway:%' OR action_kind LIKE 'start-job:model-health:%' OR action_kind LIKE 'mutate-policy:model:%'",
  },
  {
    key: "pipeline",
    label: "Pipeline actions",
    perActionMinutes: 3,
    sql: "action_kind LIKE 'autopipeline.%' OR action_kind LIKE 'regen.%' OR action_kind LIKE 'start-job:dossier:%'",
  },
] as const;

export const SYSTEM_LABOR_MINUTES_PER_ACTION = Object.fromEntries(
  SYSTEM_LABOR_CATEGORIES.map((category) => [category.label, category.perActionMinutes]),
) as Record<string, number>;

export type SystemLaborStatsValue = {
  categories: Array<{ label: string; count: number }>;
  totalActions: number;
  timeSaved: Configured<{ minutes: number; assumptions: Record<string, number> }>;
  busiest: Array<{ name: string; count: number }>;
};

export type SystemLaborStats = Configured<SystemLaborStatsValue>;
export type SystemLaborPeriod = { start: number; end: number };
export type WeeklySystemLaborResult = { generated: boolean; path?: string; skipped?: "db-disabled" | "before-window" | "already-generated" };

type CategorizedRow = { category: CategoryKey; action_kind: string; count: number };

function categoryCaseSql(): string {
  return SYSTEM_LABOR_CATEGORIES.map((category) => `WHEN ${category.sql} THEN '${category.key}'`).join("\n        ");
}

export function collectSystemLaborStats(periodStart: number, periodEnd: number): SystemLaborStats {
  const db = getDashboardDb();
  if (!db) return { configured: false };
  const tenantId = getCurrentTenantContext().tenantId;
  const source = db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'action_audit'")
    .get() as { present: number } | null;
  if (!source) return { configured: false };

  const rows = db.query(`WITH categorized AS (
      SELECT action_kind,
        CASE
          ${categoryCaseSql()}
          ELSE NULL
        END AS category
      FROM action_audit
      WHERE ts >= ? AND ts < ?
        AND result_status = 'success'
        AND (tenant_id = ? OR tenant_id IS NULL)
    )
    SELECT category, action_kind, COUNT(*) AS count
    FROM categorized
    WHERE category IS NOT NULL
    GROUP BY category, action_kind`).all(periodStart, periodEnd, tenantId) as CategorizedRow[];

  const categoryCounts = new Map<CategoryKey, number>();
  const actionCounts = new Map<string, number>();
  for (const row of rows) {
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + row.count);
    actionCounts.set(row.action_kind, (actionCounts.get(row.action_kind) ?? 0) + row.count);
  }

  const categories = SYSTEM_LABOR_CATEGORIES.map((category) => ({
    label: category.label,
    count: categoryCounts.get(category.key) ?? 0,
  }));
  const totalActions = categories.reduce((sum, category) => sum + category.count, 0);
  const minutes = SYSTEM_LABOR_CATEGORIES.reduce(
    (sum, category) => sum + (categoryCounts.get(category.key) ?? 0) * category.perActionMinutes,
    0,
  );
  const busiest = [...actionCounts.entries()]
    .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  return {
    configured: true,
    categories,
    totalActions,
    timeSaved: { configured: true, minutes, assumptions: { ...SYSTEM_LABOR_MINUTES_PER_ACTION } },
    busiest,
  };
}

function estimatedHours(minutes: number): string {
  if (minutes === 0) return "0";
  return (minutes / 60).toFixed(1).replace(/\.0$/, "");
}

function reportLead(stats: SystemLaborStats): string {
  if (!stats.configured) return "System labor data is not configured because action_audit is unavailable.";
  return `This week the admin center performed ${stats.totalActions} actions on your behalf — an estimated ~${estimatedHours(stats.timeSaved.configured ? stats.timeSaved.minutes : 0)} hours you did not have to spend.`;
}

export function renderSystemLaborReport(stats: SystemLaborStats, period: SystemLaborPeriod): string {
  const week = isoWeek(new Date(period.end));
  const lines = [
    `# System Labor Report — ${week.year}-W${String(week.week).padStart(2, "0")}`,
    "",
    `Period: ${new Date(period.start).toISOString()} — ${new Date(period.end).toISOString()}`,
    "",
    reportLead(stats),
    "",
    "## Work performed",
  ];

  if (!stats.configured) {
    lines.push("Not configured: action_audit is unavailable.");
  } else {
    lines.push("| Category | Actions |", "| --- | ---: |");
    stats.categories.forEach((category) => lines.push(`| ${category.label} | ${category.count} |`));
    lines.push(`| **Total** | **${stats.totalActions}** |`);
  }

  lines.push("", "## Busiest action kinds");
  if (!stats.configured) lines.push("Not configured: action_audit is unavailable.");
  else if (stats.busiest.length === 0) lines.push("No categorized system actions this period.");
  else stats.busiest.forEach((action, index) => lines.push(`${index + 1}. \`${action.name}\` — ${action.count}`));

  lines.push("", "## Time-saved assumptions");
  lines.push("This is a conservative estimate, not measured operator time. Minutes assumed per successful action:");
  SYSTEM_LABOR_CATEGORIES.forEach((category) => lines.push(`- ${category.label}: ${category.perActionMinutes} minutes`));
  if (stats.configured && stats.timeSaved.configured) {
    lines.push("", `Estimated total: ${stats.timeSaved.minutes} minutes (~${estimatedHours(stats.timeSaved.minutes)} hours).`);
  }
  return `${lines.join("\n")}\n`;
}

function reportRoot(): string {
  return process.env.DASHBOARD_AI_VAULT_DIR ?? process.env.DASHBOARD_REPORTS_VAULT_DIR ?? "/opt/ai-vault";
}

export async function generateWeeklySystemLaborReport(opts: { force?: boolean; now?: number } = {}): Promise<WeeklySystemLaborResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const gate = await maybeGenerateWeeklySystemLaborReport({ now, generate: false });
    if (!gate.generated) return gate;
  }

  const period = { start: now - WEEK_MS, end: now };
  const stats = collectSystemLaborStats(period.start, period.end);
  const markdown = renderSystemLaborReport(stats, period);
  const tenantId = getCurrentTenantContext().tenantId;
  const date = new Date(now).toISOString().slice(0, 10);
  const relativePath = `weekly/${date}-system-labor.md`;
  const path = join(reportRoot(), relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf8");

  const db = getDashboardDb()!;
  db.query("INSERT INTO report_archive (ts, kind, path, summary) VALUES (?, ?, ?, ?)")
    .run(now, WEEKLY_SYSTEM_LABOR_KIND, relativePath, markdown);
  db.query(`INSERT OR REPLACE INTO report_runs
    (id, tenant_id, template_id, params_json, status, output_json, row_count, started_at, finished_at, error)
    VALUES (?, ?, ?, ?, 'success', ?, 1, ?, ?, NULL)`)
    .run(`weekly-system-labor-${tenantId}-${now}`, tenantId, WEEKLY_SYSTEM_LABOR_KIND,
      JSON.stringify({ fromTs: period.start, toTs: period.end }),
      JSON.stringify({ rows: [{ markdown }], rowCount: 1, generatedAt: now }), now, now);

  const week = isoWeek(new Date(now));
  const lead = reportLead(stats);
  const minutes = stats.configured && stats.timeSaved.configured ? stats.timeSaved.minutes : 0;
  const telegram = [
    `System Labor Report — ${week.year}-W${String(week.week).padStart(2, "0")}`,
    lead,
    `Estimated time saved: ~${estimatedHours(minutes)} hours (assumption-based) · Full report on /reports`,
  ].join("\n");
  let sent = false;
  try { sent = await sendTelegramAlert(telegram); } catch (error) { console.error("[system-labor] telegram send threw", error); }
  try {
    writeActionAudit({ actionKind: "reports.system-labor", actor: "system", actorSource: "scheduler", target: WEEKLY_SYSTEM_LABOR_KIND,
      targetType: "report", result: sent ? "sent" : "generated", resultStatus: "success", resultJson: { path, sent, stats } });
  } catch (error) { console.error("[system-labor] audit write failed", error); }
  return { generated: true, path };
}

export async function maybeGenerateWeeklySystemLaborReport(opts: { force?: boolean; now?: number; generate?: boolean } = {}): Promise<WeeklySystemLaborResult> {
  if (!isDashboardDbEnabled() || !getDashboardDb()) return { generated: false, skipped: "db-disabled" };
  const now = opts.now ?? Date.now();
  const { mondayStart, scheduledAt } = mondayWindow(now);
  if (!opts.force && now < scheduledAt) return { generated: false, skipped: "before-window" };
  const row = getDashboardDb()!.query(`SELECT COUNT(*) AS count FROM report_archive
    WHERE kind = ? AND ts >= ? AND ts < ?`).get(WEEKLY_SYSTEM_LABOR_KIND, mondayStart, mondayStart + WEEK_MS) as { count: number } | null;
  if (!opts.force && (row?.count ?? 0) > 0) return { generated: false, skipped: "already-generated" };
  if (opts.generate === false) return { generated: true };
  return generateWeeklySystemLaborReport({ force: true, now });
}
