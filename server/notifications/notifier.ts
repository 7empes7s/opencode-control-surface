import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit, readNotificationRules, readOperatorState, writeOperatorState } from "../db/writer.ts";
import { sendTelegramAlert } from "./telegram.ts";
import type { Insight } from "../insights/types.ts";
import { listInsights } from "../insights/store.ts";
import { dispatchEventFireAndForget } from "../webhooks/dispatcher.ts";

const NOTIFIED_MARKER_KEY = "insights:telegram:notified";
const DEFAULT_RULE_KIND = "insight.critical-high";
const REVIEW_URL = "https://control.techinsiderbytes.com/insights";

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

function formatTelegramMessage(insight: Insight): string {
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
    `Review: ${REVIEW_URL}`,
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

    for (const insight of insights) {
      if (typeof notified[insight.id] === "number") {
        baseResult.deduped += 1;
        continue;
      }
      const text = formatTelegramMessage(insight);
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
  REVIEW_URL,
  readNotifiedMap,
  writeNotifiedMap,
  ensureDefaultRuleSeeded,
  formatTelegramMessage,
  ruleChannelsEnabled,
};
