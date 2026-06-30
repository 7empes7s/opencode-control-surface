import { getDashboardDb } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getAiAnalysisBySignature, signatureFor } from "./ai.ts";
import { updateInsightStatus, upsertInsight } from "./store.ts";
import type { Insight } from "./types.ts";
import {
  SAFE_AUTO_ACTIONS,
  isSafeAutoAction,
  riskTierFor,
  loadAutoApplyPolicy,
  policyKeyForAction,
  type RiskTier,
} from "./autoapplyPolicy.ts";

export { SAFE_AUTO_ACTIONS, isSafeAutoAction, riskTierFor, type RiskTier };

export type AutoApplyPreviewRow = {
  insightId: string;
  sourceKey: string;
  actionDescriptorId: string | null;
  tier: RiskTier;
  wouldApply: boolean;
  reason: string;
};

let autoApplyInFlight = false;
let nowProvider = () => Date.now();

export function _setAutoApplyNowForTests(fn: (() => number) | null): void {
  nowProvider = fn ?? (() => Date.now());
}

function requestJsonContainsSourceKey(requestJson: string | null, sourceKey: string): boolean {
  if (!requestJson) return false;
  try {
    const parsed = JSON.parse(requestJson) as { sourceKey?: unknown };
    return parsed.sourceKey === sourceKey;
  } catch {
    return false;
  }
}

function autoApplyCountInTrailingHour(now: number): number {
  const db = getDashboardDb();
  if (!db) return 0;
  try {
    const row = db.query(`
      SELECT COUNT(*) AS count
      FROM action_audit
      WHERE action_kind = 'insights.auto-apply'
        AND result_status = 'success'
        AND ts >= ?
    `).get(now - 60 * 60_000) as { count: number } | null;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

function failedAutoApplyCountForSource(sourceKey: string, since: number): number {
  const db = getDashboardDb();
  if (!db) return 0;
  try {
    const rows = db.query(`
      SELECT request_json
      FROM action_audit
      WHERE action_kind = 'insights.auto-apply'
        AND result_status = 'failed'
        AND ts >= ?
      ORDER BY ts DESC
      LIMIT 200
    `).all(since) as Array<{ request_json: string | null }>;
    return rows.filter((row) => requestJsonContainsSourceKey(row.request_json, sourceKey)).length;
  } catch {
    return 0;
  }
}

function emitFlappingInsight(insight: Insight, failures: number): void {
  const sourceKey = insight.sourceKey ?? insight.id;
  upsertInsight({
    id: `insight_autoapply_flapping_${sourceKey.replace(/[^a-z0-9]+/gi, "_").slice(0, 120)}`,
    sourceKey: `security:autoapply-flapping:${sourceKey}`,
    domain: "security",
    severity: "high",
    title: "Auto-apply circuit breaker tripped",
    plainSummary: `Auto-apply failed ${failures} times for ${sourceKey}. The remediation has been left for operator review.`,
    confidence: 0.9,
    evidenceRefs: [
      { label: "Auto-apply audit", kind: "db", ref: "action_audit", redacted: true },
      { label: "Original finding", kind: "db", ref: `insights:${insight.id}`, redacted: true },
    ],
    actionDescriptorId: null,
    manualPageHref: `/insights?focus=${encodeURIComponent(sourceKey)}`,
    createdAt: nowProvider(),
  });
}

function aiConfidenceGate(insight: Insight, threshold: number): { ok: boolean; confidence: number | null; reason: string } {
  const analysis = getAiAnalysisBySignature(signatureFor(insight));
  if (!analysis) {
    return { ok: false, confidence: null, reason: `waiting for AI analysis confidence >= ${threshold}` };
  }
  if (analysis.confidence < threshold) {
    return {
      ok: false,
      confidence: analysis.confidence,
      reason: `AI confidence ${analysis.confidence.toFixed(2)} is below auto-apply threshold ${threshold}`,
    };
  }
  return {
    ok: true,
    confidence: analysis.confidence,
    reason: `AI confidence ${analysis.confidence.toFixed(2)} meets threshold ${threshold}`,
  };
}

export function previewAutoApplyCandidates(insights: Insight[], limit = 4): AutoApplyPreviewRow[] {
  const policy = loadAutoApplyPolicy();
  const now = nowProvider();
  const appliedThisHour = autoApplyCountInTrailingHour(now);
  let remaining = Math.max(0, policy.maxAutoAppliesPerHour - appliedThisHour);
  const rows: AutoApplyPreviewRow[] = [];

  for (const insight of insights.filter((i) => i.status === "open" && i.actionDescriptorId).slice(0, limit)) {
    const tier = riskTierFor(insight);
    const sourceKey = insight.sourceKey ?? insight.id;
    const failures = failedAutoApplyCountForSource(sourceKey, now - policy.circuitBreakerWindowMs);
    let wouldApply = tier === "auto";
    let reason = tier === "auto"
      ? `policy key ${policyKeyForAction(insight.actionDescriptorId ?? "")} allows auto`
      : tier === "review"
        ? "policy requires operator review"
        : "policy is off or no action is available";

    if (wouldApply && remaining <= 0) {
      wouldApply = false;
      reason = `rate limit reached (${policy.maxAutoAppliesPerHour}/hour)`;
    } else if (wouldApply && failures >= policy.circuitBreakerThreshold) {
      wouldApply = false;
      reason = `circuit breaker tripped after ${failures} failed attempt(s)`;
    } else if (wouldApply) {
      const gate = aiConfidenceGate(insight, policy.minAiConfidenceForAutoApply);
      wouldApply = gate.ok;
      reason = gate.ok ? `${reason}; ${gate.reason}` : gate.reason;
    }

    if (wouldApply) remaining--;
    rows.push({
      insightId: insight.id,
      sourceKey,
      actionDescriptorId: insight.actionDescriptorId,
      tier,
      wouldApply,
      reason,
    });
  }

  return rows;
}

// Auto-apply the safe remediation for any open finding whose action is on the
// allowlist. Audited (trigger=auto), capped, guarded against overlap, and a
// no-op without the operator token. Never throws.
export async function autoApplySafeInsights(insights: Insight[], limit = 4): Promise<number> {
  if (!getDashboardDb() || autoApplyInFlight) return 0;
  const token = process.env.OPERATOR_TOKEN;
  if (!token) return 0; // audited mutations require the operator token

  autoApplyInFlight = true;
  try {
    const policy = loadAutoApplyPolicy();
    const now = nowProvider();
    let remaining = Math.max(0, policy.maxAutoAppliesPerHour - autoApplyCountInTrailingHour(now));
    if (remaining <= 0) return 0;
    const candidates = insights.filter((i) => i.status === "open" && isSafeAutoAction(i.actionDescriptorId));
    let applied = 0;
    for (const insight of candidates.slice(0, limit)) {
      if (remaining <= 0) break;
      const sourceKey = insight.sourceKey ?? insight.id;
      const failures = failedAutoApplyCountForSource(sourceKey, now - policy.circuitBreakerWindowMs);
      if (failures >= policy.circuitBreakerThreshold) {
        emitFlappingInsight(insight, failures);
        continue;
      }
      const gate = aiConfidenceGate(insight, policy.minAiConfidenceForAutoApply);
      if (!gate.ok) continue;
      if (await runAutoApply(insight, token)) applied++;
      remaining--;
    }
    return applied;
  } finally {
    autoApplyInFlight = false;
  }
}

async function runAutoApply(insight: Insight, token: string): Promise<boolean> {
  try {
    const policy = loadAutoApplyPolicy();
    const aiConfidence = getAiAnalysisBySignature(signatureFor(insight))?.confidence ?? null;
    const { executeActionHandler } = await import("../api/execute.ts");
    const req = new Request("http://localhost/api/actions/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor": "sentinel-auto",
        "x-operator-token": token,
      },
      body: JSON.stringify({
        actionId: insight.actionDescriptorId,
        reason: `Auto-applied safe remediation for ${insight.sourceKey ?? insight.id}`,
        confirmed: true,
        params: {},
      }),
    });
    const res = await executeActionHandler(req);
    const body = await res.json().catch(() => ({ ok: false, error: "no readable result" })) as { ok?: boolean; error?: string };
    const ok = res.ok && body.ok !== false;

    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-apply",
      actionId: insight.actionDescriptorId ?? undefined,
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      request: {
        insightId: insight.id,
        trigger: "auto",
        sourceKey: insight.sourceKey ?? insight.id,
        confidence: insight.confidence,
        aiConfidence,
        minAiConfidenceForAutoApply: policy.minAiConfidenceForAutoApply,
        policyKey: policyKeyForAction(insight.actionDescriptorId ?? ""),
        tier: riskTierFor(insight),
      },
      resultStatus: ok ? "success" : "failed",
      result: ok ? "auto-applied safe remediation" : (body.error ?? "auto-apply failed"),
      rollbackHint: undefined,
    });

    if (ok) updateInsightStatus(insight.id, "applied");
    return ok;
  } catch (err) {
    console.error("[insights-autoapply] failed", err instanceof Error ? err.message : err);
    return false;
  }
}
