import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit, readNotificationRules, readOperatorState, writeOperatorState } from "../db/writer.ts";
import { sendTelegramAlert } from "./telegram.ts";
import type { Insight } from "../insights/types.ts";
import { listInsights } from "../insights/store.ts";
import { dispatchEventFireAndForget } from "../webhooks/dispatcher.ts";

const NOTIFIED_MARKER_KEY = "insights:telegram:notified";
const DEFAULT_RULE_KIND = "insight.critical-high";
const DEFAULT_CONTROL_SURFACE_BASE_URL = "https://control.techinsiderbytes.com";

type AutoApplyActivity = {
  applied: number;
  cooldownClears: number;
  reverted: number;
  flapped: number;
  failed: number;
};

type DedupeMap = Record<string, number>;

function readNotifiedMap(): DedupeMap {
  const raw = readOperatorState(NOTIFIED_MARKER_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: DedupeMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function writeNotifiedMap(map: DedupeMap): void {
  writeOperatorState(NOTIFIED_MARKER_KEY, map);
}

function ensureDefaultRuleSeeded(): void {
  if (!isDashboardDbEnabled()) return;
  const db = getDashboardDb();
  if (!db) return;
  try {
    const existing = db.query(`
      SELECT id FROM notification_rules
      WHERE kind = ?
      ORDER BY id ASC LIMIT 1
    `).get(DEFAULT_RULE_KIND) as { id: number } | null;
    if (existing) return;
    db.query(`
      INSERT INTO notification_rules (kind, enabled, threshold_json, channels_json, updated_at)
      VALUES (?, 1, ?, ?, ?)
    `).run(
      DEFAULT_RULE_KIND,
      JSON.stringify({ severities: ["critical", "high"] }),
      JSON.stringify(["telegram"]),
      Date.now(),
    );
  } catch (err) {
    console.error("[notifier] failed to seed default notification rule", err);
  }
}

function ruleChannelsEnabled(): boolean {
  try {
    const rules = readNotificationRules({ kind: DEFAULT_RULE_KIND, limit: 1 });
    if (rules.length === 0) return false;
    const rule = rules[0];
    if (!rule.enabled) return false;
    const channels = Array.isArray(rule.channels) ? rule.channels : [];
    return channels.includes("telegram");
  } catch {
    return false;
  }
}

function normalizeBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
    return url.origin;
  } catch {
    return null;
  }
}

function configuredControlBaseUrl(): string {
  const direct = normalizeBaseUrl(
    process.env.CONTROL_SURFACE_BASE_URL ??
      process.env.DASHBOARD_PUBLIC_URL ??
      process.env.PUBLIC_BASE_URL,
  );
  if (direct) return direct;

  const firstPublicUrl = (process.env.PUBLIC_URLS ?? "")
    .split(",")
    .map((part) => normalizeBaseUrl(part))
    .find((part): part is string => Boolean(part));
  return firstPublicUrl ?? DEFAULT_CONTROL_SURFACE_BASE_URL;
}

function focusUrlForInsight(insight: Insight): string {
  const focus = encodeURIComponent(insight.sourceKey ?? insight.id);
  return `${configuredControlBaseUrl()}/insights?focus=${focus}`;
}

function readAutoApplyActivity(scanWindowMs: number): AutoApplyActivity {
  const empty = { applied: 0, cooldownClears: 0, reverted: 0, flapped: 0, failed: 0 };
  if (!isDashboardDbEnabled()) return empty;
  const db = getDashboardDb();
  if (!db) return empty;
  const cutoff = Date.now() - scanWindowMs;
  try {
    const autoRows = db.query(`
      SELECT action_id, result_status
      FROM action_audit
      WHERE action_kind = 'insights.auto-apply'
        AND ts >= ?
    `).all(cutoff) as Array<{ action_id: string | null; result_status: string | null }>;
    const revertedRow = db.query(`
      SELECT COUNT(*) AS count
      FROM action_audit
      WHERE ts >= ?
        AND lower(COALESCE(reason, '') || ' ' || COALESCE(result, '') || ' ' || COALESCE(action_id, '')) LIKE '%revert%'
    `).get(cutoff) as { count: number } | null;
    const flappedRow = db.query(`
      SELECT COUNT(*) AS count
      FROM insights
      WHERE created_at >= ?
        AND source_key LIKE 'security:autoapply-flapping:%'
    `).get(cutoff) as { count: number } | null;
    const appliedRows = autoRows.filter((row) => row.result_status === "success");
    return {
      applied: appliedRows.length,
      cooldownClears: appliedRows.filter((row) => row.action_id?.includes(":cooldown-clear")).length,
      reverted: revertedRow?.count ?? 0,
      flapped: flappedRow?.count ?? 0,
      failed: autoRows.filter((row) => row.result_status === "failed").length,
    };
  } catch (err) {
    console.error("[notifier] auto-apply activity lookup failed", err);
    return empty;
  }
}

function formatAutoApplyActivity(activity: AutoApplyActivity): string {
  const parts: string[] = [];
  if (activity.cooldownClears > 0) {
    parts.push(`auto-cleared ${activity.cooldownClears} expired cooldown${activity.cooldownClears === 1 ? "" : "s"}`);
  }
  const otherApplied = Math.max(0, activity.applied - activity.cooldownClears);
  if (otherApplied > 0) {
    parts.push(`auto-applied ${otherApplied} safe fix${otherApplied === 1 ? "" : "es"}`);
  }
  if (activity.reverted > 0) {
    parts.push(`reverted ${activity.reverted} auto-fix${activity.reverted === 1 ? "" : "es"}`);
  }
  if (activity.flapped > 0) {
    parts.push(`${activity.flapped} flapping finding${activity.flapped === 1 ? "" : "s"} sent to review`);
  }
  if (activity.failed > 0) {
    parts.push(`kept ${activity.failed} failed auto-fix attempt${activity.failed === 1 ? "" : "s"} in review`);
  }
  if (parts.length === 0) return "Auto-fix activity: no safe auto-fixes needed in this scan window.";
  return `Auto-fix activity handled: ${parts.join("; ")}.`;
}

function formatTelegramMessage(insight: Insight, activity: AutoApplyActivity = readAutoApplyActivity(15 * 60 * 1000)): string {
  const sev = insight.severity.toUpperCase();
  const title = insight.title.length > 200 ? `${insight.title.slice(0, 197)}...` : insight.title;
  const summary = insight.plainSummary.length > 400
    ? `${insight.plainSummary.slice(0, 397)}...`
    : insight.plainSummary;
  return [
    `[${sev}] ${title}`,
    "",
    summary,
    "",
    formatAutoApplyActivity(activity),
    "",
    `Review: ${focusUrlForInsight(insight)}`,
  ].join("\n");
}

function findCriticalOpenInsights(scanWindowMs: number): Insight[] {
  if (!isDashboardDbEnabled()) return [];
  const cutoff = Date.now() - scanWindowMs;
  const all = listInsights("open");
  return all.filter((i) => {
    if (i.status !== "open") return false;
    if (i.severity !== "critical" && i.severity !== "high") return false;
    if (i.createdAt < cutoff) return false;
    return true;
  });
}

export type NotifyResult = {
  scanned: number;
  sent: number;
  deduped: number;
  skipped: number;
  ruleEnabled: boolean;
};

export async function notifyCriticalFindings(scanWindowMs = 15 * 60 * 1000): Promise<NotifyResult> {
  const baseResult: NotifyResult = {
    scanned: 0,
    sent: 0,
    deduped: 0,
    skipped: 0,
    ruleEnabled: false,
  };

  try {
    ensureDefaultRuleSeeded();
    if (!ruleChannelsEnabled()) {
      return baseResult;
    }
    baseResult.ruleEnabled = true;

    const insights = findCriticalOpenInsights(scanWindowMs);
    baseResult.scanned = insights.length;
    if (insights.length === 0) return baseResult;

    const notified = readNotifiedMap();
    const now = Date.now();
    const fresh: DedupeMap = { ...notified };
    const autoApplyActivity = readAutoApplyActivity(scanWindowMs);

    for (const insight of insights) {
      if (typeof notified[insight.id] === "number") {
        baseResult.deduped += 1;
        continue;
      }
      const text = formatTelegramMessage(insight, autoApplyActivity);
      let sent = false;
      try {
        sent = await sendTelegramAlert(text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[notifier] sendTelegramAlert threw for ${insight.id}: ${message.slice(0, 200)}`);
        sent = false;
      }
      if (sent) {
        fresh[insight.id] = now;
        baseResult.sent += 1;
        try {
          writeActionAudit({
            actor: "insights-notifier",
            actorSource: "scheduler",
            actionKind: "notify.telegram",
            targetType: "insight",
            targetId: insight.id,
            risk: "low",
            resultStatus: "success",
            resultJson: {
              severity: insight.severity,
              domain: insight.domain,
              title: insight.title,
            },
          });
        } catch (auditErr) {
          console.error("[notifier] audit write failed", auditErr);
        }
        // Phase G: fire-and-forget webhook for critical/high insights
        try {
          dispatchEventFireAndForget("insight.critical", {
            insightId: insight.id,
            severity: insight.severity,
            domain: insight.domain,
            title: insight.title,
            plainSummary: insight.plainSummary,
            manualPageHref: insight.manualPageHref,
          });
        } catch { /* never throw out of notify path */ }
      } else {
        baseResult.skipped += 1;
      }
    }

    try {
      writeNotifiedMap(fresh);
    } catch (writeErr) {
      console.error("[notifier] failed to persist notified map", writeErr);
    }

    return baseResult;
  } catch (err) {
    console.error("[notifier] notifyCriticalFindings failed", err);
    return baseResult;
  }
}

export const __test_only = {
  NOTIFIED_MARKER_KEY,
  DEFAULT_RULE_KIND,
  DEFAULT_CONTROL_SURFACE_BASE_URL,
  readNotifiedMap,
  writeNotifiedMap,
  ensureDefaultRuleSeeded,
  formatTelegramMessage,
  focusUrlForInsight,
  readAutoApplyActivity,
  formatAutoApplyActivity,
  ruleChannelsEnabled,
};
