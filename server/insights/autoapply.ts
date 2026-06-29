import { getDashboardDb } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { updateInsightStatus } from "./store.ts";
import { executeActionHandler } from "../api/execute.ts";
import type { Insight } from "./types.ts";

// Actions safe to apply with NO human review: idempotent / reversible and
// non-customer-facing. This set is deliberately tiny. Service restarts, pipeline
// resume, GPU tunnel restarts, model blocks, and budget changes are EXCLUDED —
// they remain review-tier (a human clicks Apply). Expanding this allowlist is a
// deliberate decision, not a default.
export const SAFE_AUTO_ACTIONS: ReadonlySet<string> = new Set<string>([
  // Re-run model discovery — exactly what model-health-check.timer does every 5h.
  "start-job:model-health:all",
  // Rotate/truncate the diagnostics log once a detector confirms size pressure.
  "start-job:infra:doctor-log-rotate",
]);

export type RiskTier = "auto" | "review" | "none";

export function isSafeAutoAction(actionId: string | null | undefined): boolean {
  if (!actionId) return false;
  if (SAFE_AUTO_ACTIONS.has(actionId)) return true;
  return actionId.startsWith("mutate-policy:model:") && actionId.endsWith(":cooldown-clear");
}

export function riskTierFor(insight: Pick<Insight, "actionDescriptorId">): RiskTier {
  if (!insight.actionDescriptorId) return "none";
  return isSafeAutoAction(insight.actionDescriptorId) ? "auto" : "review";
}

let autoApplyInFlight = false;

// Auto-apply the safe remediation for any open finding whose action is on the
// allowlist. Audited (trigger=auto), capped, guarded against overlap, and a
// no-op without the operator token. Never throws.
export async function autoApplySafeInsights(insights: Insight[], limit = 4): Promise<number> {
  if (!getDashboardDb() || autoApplyInFlight) return 0;
  const token = process.env.OPERATOR_TOKEN;
  if (!token) return 0; // audited mutations require the operator token

  autoApplyInFlight = true;
  try {
    const candidates = insights.filter((i) => i.status === "open" && isSafeAutoAction(i.actionDescriptorId));
    let applied = 0;
    for (const insight of candidates.slice(0, limit)) {
      if (await runAutoApply(insight, token)) applied++;
    }
    return applied;
  } finally {
    autoApplyInFlight = false;
  }
}

async function runAutoApply(insight: Insight, token: string): Promise<boolean> {
  try {
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
      request: { insightId: insight.id, trigger: "auto", sourceKey: insight.sourceKey ?? insight.id },
      resultStatus: ok ? "success" : "failed",
      result: ok ? "auto-applied safe remediation" : (body.error ?? "auto-apply failed"),
    });

    if (ok) updateInsightStatus(insight.id, "applied");
    return ok;
  } catch (err) {
    console.error("[insights-autoapply] failed", err instanceof Error ? err.message : err);
    return false;
  }
}
