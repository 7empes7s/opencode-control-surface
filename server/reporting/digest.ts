import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { getTrustScoreHistory, computeTrustScore } from "../security/score.ts";
import { listAgents } from "../agents/registry.ts";
import { sendTelegramAlert } from "../notifications/telegram.ts";
import { writeActionAudit } from "../db/writer.ts";
import { computeAdminHealthScore, getAdminHealthTrend } from "../insights/health.ts";

export const DIGEST_MARKER_KEY = "last_digest_at";
export const DIGEST_KIND = "daily-digest";
export const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 3000;

type CountRow = { count: number };
type SumRow = { total: number | null };
type MetricRow = { key: string; value_json: string; ts: number };
type FindingRow = { id: string; severity: string; domain: string; title: string; source_key: string | null; created_at: number };
type BudgetRow = { id: string; scope: string; project_id: string | null; daily_cap_usd: number | null; monthly_cap_usd: number | null };

function safeCount(db: ReturnType<typeof getDashboardDb>, sql: string, params: (string | number)[] = []): number {
  if (!db) return 0;
  try {
    const row = db.query(sql).get(...params) as CountRow | null;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

function safeSum(db: ReturnType<typeof getDashboardDb>, sql: string, params: (string | number)[] = []): number {
  if (!db) return 0;
  try {
    const row = db.query(sql).get(...params) as SumRow | null;
    return row?.total ?? 0;
  } catch {
    return 0;
  }
}

function fmtPct(num: number, denom: number): string {
  if (denom <= 0) return "0%";
  return `${Math.round((num / denom) * 100)}%`;
}

function fmtCents(cents: number): string {
  if (cents <= 0) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDelta(delta: number): string {
  if (delta === 0) return "no change";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function loadDigestMarker(): { lastSent: number | null; tenantId: string } {
  const db = getDashboardDb();
  if (!db) return { lastSent: null, tenantId: getCurrentTenantContext().tenantId };
  const ctx = getCurrentTenantContext();
  try {
    const row = db
      .query(
        `SELECT value_json FROM system_configs WHERE key = ?`,
      )
      .get(DIGEST_MARKER_KEY) as { value_json: string } | null;
    if (!row) return { lastSent: null, tenantId: ctx.tenantId };
    const parsed = JSON.parse(row.value_json) as { lastSent?: number; lastDigestAt?: number; tenantId?: string };
    return { lastSent: parsed.lastDigestAt ?? parsed.lastSent ?? null, tenantId: parsed.tenantId ?? ctx.tenantId };
  } catch {
    return { lastSent: null, tenantId: ctx.tenantId };
  }
}

function saveDigestMarker(tenantId: string, lastSent: number): void {
  const db = getDashboardDb();
  if (!db) return;
  try {
    const existing = db.query(`SELECT value_json FROM system_configs WHERE key = ?`)
      .get(DIGEST_MARKER_KEY) as { value_json: string } | null;
    const nextJson = JSON.stringify({ lastDigestAt: lastSent, tenantId });
    db.query(
      `INSERT OR REPLACE INTO system_configs (key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?)`,
    ).run(DIGEST_MARKER_KEY, nextJson, Date.now(), "digest-scheduler");
    db.query(
      `INSERT INTO config_changes (ts, key, old_value_json, new_value_json, changed_by, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(Date.now(), DIGEST_MARKER_KEY, existing?.value_json ?? null, nextJson, "digest-scheduler", "daily digest marker");
  } catch (err) {
    console.error("[digest] failed to save marker", err instanceof Error ? err.message : err);
  }
}

function archiveDigest(tenantId: string, text: string, ts: number): void {
  const db = getDashboardDb();
  if (!db) return;
  try {
    db.query(
      `INSERT INTO report_archive (ts, kind, path, summary) VALUES (?, ?, ?, ?)`,
    ).run(ts, DIGEST_KIND, `digests/${tenantId}/${ts}.txt`, text);
  } catch (err) {
    console.error("[digest] failed to persist archive row", err instanceof Error ? err.message : err);
  }
}

function appendDigestToVault(text: string, ts: number): string | null {
  const root = process.env.DASHBOARD_AI_VAULT_DIR ?? process.env.DASHBOARD_REPORTS_VAULT_DIR ?? "/opt/ai-vault";
  const dateKey = new Date(ts).toISOString().slice(0, 10);
  const dir = join(root, "daily");
  const path = join(dir, `${dateKey}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, `\n\n## Operator digest ${new Date(ts).toISOString()}\n\n${text}\n`, "utf8");
    return path;
  } catch (err) {
    console.error("[digest] vault append failed", err instanceof Error ? err.message : err);
    return null;
  }
}

export type DigestStats = {
  trustScore: number;
  trustDelta: number | null;
  oldestHistoryTs: number | null;
  costEventsCount: number;
  costEventsTotalCents: number;
  zeroCostPct: string;
  insightsOpened: number;
  insightsAutoResolved: number;
  insightsApplied: number;
  reasonerIncidents: number;
  topAgents: Array<{ name: string; audit7d: number }>;
  bestModel: { model: string; score: number } | null;
  healthScore: number;
  healthTrendDelta: number | null;
  healthTrendSamples: number;
  topOpenFindings: Array<{ severity: string; domain: string; title: string; sourceKey: string | null }>;
  autoFixesApplied: number;
  autoFixLabels: string[];
  costVsCap: { spentCents: number; capCents: number | null; usagePct: number | null; label: string };
};

export function collectDigestStats(periodStart = Date.now() - DIGEST_INTERVAL_MS, periodEnd = Date.now()): DigestStats {
  const db = getDashboardDb();
  const ctx = getCurrentTenantContext();
  const tenant = ctx.tenantId;

  const trustScore = computeTrustScore().score;
  const history = getTrustScoreHistory(7);
  const oldest = history.length > 0 ? history[0] : null;
  const trustDelta = oldest ? trustScore - oldest.score : null;

  const costEventsCount = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM cost_events WHERE tenant_id = ? AND ts >= ?`,
    [tenant, periodStart],
  );
  const costEventsTotalCents = safeSum(
    db,
    `SELECT COALESCE(SUM(cost_cents), 0) AS total FROM cost_events WHERE tenant_id = ? AND ts >= ?`,
    [tenant, periodStart],
  );
  const zeroCostCount = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM cost_events WHERE tenant_id = ? AND ts >= ? AND cost_cents = 0`,
    [tenant, periodStart],
  );

  const insightsOpened = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM insights WHERE tenant_id = ? AND created_at >= ?`,
    [tenant, periodStart],
  );
  const insightsAutoResolved = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM insights
       WHERE tenant_id = ? AND status = 'resolved' AND resolved_at >= ? AND resolved_at IS NOT NULL`,
    [tenant, periodStart],
  );
  const insightsApplied = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM insights WHERE tenant_id = ? AND status = 'applied' AND created_at >= ?`,
    [tenant, periodStart],
  );

  const reasonerIncidents = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM reasoner_incidents WHERE tenant_id = ? AND last_seen >= ?`,
    [tenant, periodStart],
  );

  let topAgents: Array<{ name: string; audit7d: number }> = [];
  try {
    const agents = listAgents()
      .filter((a) => a.audit7d > 0)
      .sort((a, b) => b.audit7d - a.audit7d)
      .slice(0, 2);
    topAgents = agents.map((a) => ({ name: a.name, audit7d: a.audit7d }));
  } catch (err) {
    console.error("[digest] listAgents failed", err instanceof Error ? err.message : err);
  }

  let bestModel: { model: string; score: number } | null = null;
  let topOpenFindings: DigestStats["topOpenFindings"] = [];
  let autoFixLabels: string[] = [];
  let autoFixesApplied = 0;
  let capCents: number | null = null;
  if (db) {
    try {
      const row = db
        .query(
          `SELECT key, value_json, ts FROM metric_samples
             WHERE source = 'model-eval' AND tenant_id = ?
             ORDER BY ts DESC LIMIT 1`,
        )
        .get(tenant) as MetricRow | null;
      if (row) {
        const parsed = JSON.parse(row.value_json) as { score?: number; error?: string | null };
        if (typeof parsed.score === "number" && parsed.score > 0 && !parsed.error) {
          bestModel = { model: row.key, score: parsed.score };
        }
      }
    } catch (err) {
      console.error("[digest] model-eval lookup failed", err instanceof Error ? err.message : err);
    }
    try {
      const rows = db.query(`
        SELECT id, severity, domain, title, source_key, created_at
        FROM insights
        WHERE tenant_id = ? AND status = 'open'
        ORDER BY
          CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END DESC,
          created_at DESC
        LIMIT 3
      `).all(tenant) as FindingRow[];
      topOpenFindings = rows.map((row) => ({
        severity: row.severity,
        domain: row.domain,
        title: row.title,
        sourceKey: row.source_key,
      }));
    } catch (err) {
      console.error("[digest] top findings lookup failed", err instanceof Error ? err.message : err);
    }
    try {
      const rows = db.query(`
        SELECT action_id, result
        FROM action_audit
        WHERE tenant_id = ?
          AND action_kind = 'insights.auto-apply'
          AND result_status = 'success'
          AND ts >= ?
          AND ts <= ?
        ORDER BY ts DESC
        LIMIT 20
      `).all(tenant, periodStart, periodEnd) as Array<{ action_id: string | null; result: string | null }>;
      autoFixesApplied = rows.length;
      autoFixLabels = rows.slice(0, 3).map((row) => row.result || row.action_id || "safe remediation");
    } catch (err) {
      console.error("[digest] auto-fix lookup failed", err instanceof Error ? err.message : err);
    }
    try {
      const budgets = db.query(`
        SELECT id, scope, project_id, daily_cap_usd, monthly_cap_usd
        FROM governance_budgets
        WHERE tenant_id = ? OR tenant_id IS NULL
      `).all(tenant) as BudgetRow[];
      for (const budget of budgets) {
        const budgetCapCents = Math.round(Math.max(budget.daily_cap_usd ?? 0, budget.monthly_cap_usd ?? 0) * 100);
        if (budgetCapCents > 0) capCents = Math.max(capCents ?? 0, budgetCapCents);
      }
    } catch (err) {
      console.error("[digest] budget cap lookup failed", err instanceof Error ? err.message : err);
    }
  }

  const healthScore = computeAdminHealthScore().score;
  const trend = getAdminHealthTrend(24);
  const healthTrendDelta = trend.length >= 2 ? healthScore - trend[0].score : null;
  const usagePct = capCents && capCents > 0 ? costEventsTotalCents / capCents : null;

  return {
    trustScore,
    trustDelta,
    oldestHistoryTs: oldest?.ts ?? null,
    costEventsCount,
    costEventsTotalCents,
    zeroCostPct: fmtPct(zeroCostCount, costEventsCount),
    insightsOpened,
    insightsAutoResolved,
    insightsApplied,
    reasonerIncidents,
    topAgents,
    bestModel,
    healthScore,
    healthTrendDelta,
    healthTrendSamples: trend.length,
    topOpenFindings,
    autoFixesApplied,
    autoFixLabels,
    costVsCap: {
      spentCents: costEventsTotalCents,
      capCents,
      usagePct,
      label: capCents ? `${fmtCents(costEventsTotalCents)} of ${fmtCents(capCents)} cap` : `${fmtCents(costEventsTotalCents)} spent; no active cap configured`,
    },
  };
}

export function renderDigestText(stats: DigestStats): string {
  const lines: string[] = [];
  const day = new Date().toISOString().slice(0, 10);

  lines.push(`Daily operator digest — ${day}`);
  lines.push("The system handled routine checks and safe remediations; this is a summary, not an alert queue.");
  lines.push("");

  const healthDelta = stats.healthTrendDelta === null ? "no prior trend sample" : `${fmtDelta(stats.healthTrendDelta)} over ${stats.healthTrendSamples} sample(s)`;
  lines.push(`Health trend: Admin Health ${stats.healthScore}/100 (${healthDelta}).`);

  const deltaSuffix = stats.trustDelta === null
    ? " (no prior 7d sample)"
    : ` (${fmtDelta(stats.trustDelta)} vs 7d ago)`;
  lines.push(`Trust score: ${stats.trustScore}/100${deltaSuffix}`);

  lines.push(
    `Cost: ${stats.costEventsCount} event(s), total ${fmtCents(stats.costEventsTotalCents)}, ${stats.zeroCostPct} free-tier.`,
  );
  lines.push(`Cost vs cap: ${stats.costVsCap.label}${stats.costVsCap.usagePct === null ? "" : ` (${Math.round(stats.costVsCap.usagePct * 100)}%)`}.`);

  lines.push(
    `Insights: ${stats.insightsOpened} opened, ${stats.insightsAutoResolved} auto-resolved, ${stats.insightsApplied} applied.`,
  );
  lines.push(
    stats.autoFixesApplied > 0
      ? `Auto-fixes applied: ${stats.autoFixesApplied} (${stats.autoFixLabels.join("; ")}).`
      : "Auto-fixes applied: none needed in this period.",
  );

  if (stats.topOpenFindings.length > 0) {
    const findings = stats.topOpenFindings
      .map((finding) => `${finding.severity}/${finding.domain}: ${finding.title}${finding.sourceKey ? ` (${finding.sourceKey})` : ""}`)
      .join("; ");
    lines.push(`Top open findings: ${findings}.`);
  } else {
    lines.push("Top open findings: none open.");
  }

  lines.push(`Reasoner incidents in period: ${stats.reasonerIncidents}`);

  if (stats.topAgents.length > 0) {
    const names = stats.topAgents.map((a) => `${a.name} (${a.audit7d})`).join(", ");
    lines.push(`Top agents by audit activity: ${names}.`);
  } else {
    lines.push("Top agents by audit activity: none in the last 7 days.");
  }

  if (stats.bestModel) {
    lines.push(`Best model (latest eval): ${stats.bestModel.model} (score ${stats.bestModel.score}).`);
  }

  return truncate(lines.join("\n"), MAX_TEXT_LENGTH);
}

export function shouldSendWeeklyDigest(force = false): boolean {
  return shouldSendDailyDigest(force);
}

export function shouldSendDailyDigest(force = false): boolean {
  if (!isDashboardDbEnabled()) return false;
  if (force) return true;
  const { lastSent } = loadDigestMarker();
  if (!lastSent) return true;
  return Date.now() - lastSent >= DIGEST_INTERVAL_MS;
}

export type DailyDigestGateResult =
  | { ran: true; text: string; sent: boolean; reason: "sent" }
  | { ran: false; sent: false; reason: "db-disabled" | "first-boot" | "not-due"; text?: string };

export async function maybeGenerateDailyDigest(opts: { firstBootTick?: boolean; force?: boolean } = {}): Promise<DailyDigestGateResult> {
  if (!isDashboardDbEnabled()) return { ran: false, sent: false, reason: "db-disabled" };
  const marker = loadDigestMarker();
  if (opts.firstBootTick) {
    if (!marker.lastSent) saveDigestMarker(marker.tenantId, Date.now());
    return { ran: false, sent: false, reason: "first-boot" };
  }
  if (!opts.force && !shouldSendDailyDigest(false)) {
    return { ran: false, sent: false, reason: "not-due" };
  }
  const result = await generateOperatorDigest({ force: true, periodStart: marker.lastSent ?? Date.now() - DIGEST_INTERVAL_MS });
  return { ran: true, sent: result.sent, text: result.text, reason: "sent" };
}

export async function generateOperatorDigest(opts: { force?: boolean; periodStart?: number } = {}): Promise<{ text: string; sent: boolean }> {
  const force = !!opts.force;
  if (!force && !shouldSendDailyDigest(false)) {
    const db = getDashboardDb();
    if (db) {
      try {
        const marker = loadDigestMarker();
        return { text: `Digest already sent at ${new Date(marker.lastSent ?? 0).toISOString()}`, sent: false };
      } catch {
        return { text: "Digest already sent recently.", sent: false };
      }
    }
    return { text: "Digest already sent recently.", sent: false };
  }

  const periodEnd = Date.now();
  const stats = collectDigestStats(opts.periodStart ?? periodEnd - DIGEST_INTERVAL_MS, periodEnd);
  const text = renderDigestText(stats);

  const ctx = getCurrentTenantContext();
  const ts = Date.now();
  archiveDigest(ctx.tenantId, text, ts);
  const vaultPath = appendDigestToVault(text, ts);

  let sent = false;
  try {
    sent = await sendTelegramAlert(text);
  } catch (err) {
    console.error("[digest] telegram send threw", err instanceof Error ? err.message : err);
  }

  try {
    writeActionAudit({
      actionKind: "reports.digest",
      actor: "system",
      actorSource: "scheduler",
      reason: `daily digest tenant=${ctx.tenantId} sent=${sent} chars=${text.length}`,
      target: "daily-digest",
      targetType: "report",
      result: sent ? "sent" : "generated",
      resultStatus: sent ? "success" : "success",
      resultJson: { textLength: text.length, sent, vaultPath, stats },
    });
  } catch (err) {
    console.error("[digest] audit write failed", err instanceof Error ? err.message : err);
  }

  saveDigestMarker(ctx.tenantId, ts);
  return { text, sent };
}
