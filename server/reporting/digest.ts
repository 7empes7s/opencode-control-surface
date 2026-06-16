import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { getTrustScoreHistory, computeTrustScore } from "../security/score.ts";
import { listAgents } from "../agents/registry.ts";
import { sendTelegramAlert } from "../notifications/telegram.ts";
import { writeActionAudit } from "../db/writer.ts";

export const DIGEST_MARKER_KEY = "digest_last_sent";
export const DIGEST_KIND = "weekly-digest";
export const DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 3000;

type CountRow = { count: number };
type SumRow = { total: number | null };
type MetricRow = { key: string; value_json: string; ts: number };

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
        `SELECT value_json, tenant_id FROM operator_state WHERE key = ?`,
      )
      .get(DIGEST_MARKER_KEY) as { value_json: string; tenant_id: string | null } | null;
    if (!row) return { lastSent: null, tenantId: ctx.tenantId };
    if (row.tenant_id && row.tenant_id !== ctx.tenantId) {
      return { lastSent: null, tenantId: ctx.tenantId };
    }
    const parsed = JSON.parse(row.value_json) as { lastSent?: number };
    return { lastSent: parsed.lastSent ?? null, tenantId: ctx.tenantId };
  } catch {
    return { lastSent: null, tenantId: ctx.tenantId };
  }
}

function saveDigestMarker(tenantId: string, lastSent: number): void {
  const db = getDashboardDb();
  if (!db) return;
  try {
    db.query(
      `INSERT INTO operator_state (key, value_json, updated_at, tenant_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         tenant_id = excluded.tenant_id`,
    ).run(DIGEST_MARKER_KEY, JSON.stringify({ lastSent, tenantId }), Date.now(), tenantId);
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
};

export function collectDigestStats(): DigestStats {
  const db = getDashboardDb();
  const ctx = getCurrentTenantContext();
  const now = Date.now();
  const sevenDaysAgo = now - DIGEST_INTERVAL_MS;
  const tenant = ctx.tenantId;

  const trustScore = computeTrustScore().score;
  const history = getTrustScoreHistory(7);
  const oldest = history.length > 0 ? history[0] : null;
  const trustDelta = oldest ? trustScore - oldest.score : null;

  const costEventsCount = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM cost_events WHERE tenant_id = ? AND ts >= ?`,
    [tenant, sevenDaysAgo],
  );
  const costEventsTotalCents = safeSum(
    db,
    `SELECT COALESCE(SUM(cost_cents), 0) AS total FROM cost_events WHERE tenant_id = ? AND ts >= ?`,
    [tenant, sevenDaysAgo],
  );
  const zeroCostCount = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM cost_events WHERE tenant_id = ? AND ts >= ? AND cost_cents = 0`,
    [tenant, sevenDaysAgo],
  );

  const insightsOpened = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM insights WHERE tenant_id = ? AND created_at >= ?`,
    [tenant, sevenDaysAgo],
  );
  const insightsAutoResolved = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM insights
       WHERE tenant_id = ? AND status = 'resolved' AND resolved_at >= ? AND resolved_at IS NOT NULL`,
    [tenant, sevenDaysAgo],
  );
  const insightsApplied = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM insights WHERE tenant_id = ? AND status = 'applied' AND created_at >= ?`,
    [tenant, sevenDaysAgo],
  );

  const reasonerIncidents = safeCount(
    db,
    `SELECT COUNT(*) AS count FROM reasoner_incidents WHERE tenant_id = ? AND last_seen >= ?`,
    [tenant, sevenDaysAgo],
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
  }

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
  };
}

export function renderDigestText(stats: DigestStats): string {
  const lines: string[] = [];
  const weekEnding = new Date().toISOString().slice(0, 10);

  lines.push(`Weekly operator digest — week ending ${weekEnding}`);
  lines.push("");

  const deltaSuffix = stats.trustDelta === null
    ? " (no prior 7d sample)"
    : ` (${fmtDelta(stats.trustDelta)} vs 7d ago)`;
  lines.push(`Trust score: ${stats.trustScore}/100${deltaSuffix}`);

  lines.push(
    `Cost: ${stats.costEventsCount} event(s), total ${fmtCents(stats.costEventsTotalCents)}, ${stats.zeroCostPct} free-tier.`,
  );

  lines.push(
    `Insights: ${stats.insightsOpened} opened, ${stats.insightsAutoResolved} auto-resolved, ${stats.insightsApplied} applied.`,
  );

  lines.push(`Reasoner incidents (7d): ${stats.reasonerIncidents}`);

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
  if (!isDashboardDbEnabled()) return false;
  if (force) return true;
  const { lastSent } = loadDigestMarker();
  if (!lastSent) return true;
  return Date.now() - lastSent >= DIGEST_INTERVAL_MS;
}

export async function generateOperatorDigest(opts: { force?: boolean } = {}): Promise<{ text: string; sent: boolean }> {
  const force = !!opts.force;
  if (!force && !shouldSendWeeklyDigest(false)) {
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

  const stats = collectDigestStats();
  const text = renderDigestText(stats);

  const ctx = getCurrentTenantContext();
  const ts = Date.now();
  archiveDigest(ctx.tenantId, text, ts);

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
      reason: `weekly digest tenant=${ctx.tenantId} sent=${sent} chars=${text.length}`,
      target: "weekly-digest",
      targetType: "report",
      result: sent ? "sent" : "generated",
      resultStatus: sent ? "success" : "success",
      resultJson: { textLength: text.length, sent, stats },
    });
  } catch (err) {
    console.error("[digest] audit write failed", err instanceof Error ? err.message : err);
  }

  saveDigestMarker(ctx.tenantId, ts);
  return { text, sent };
}
