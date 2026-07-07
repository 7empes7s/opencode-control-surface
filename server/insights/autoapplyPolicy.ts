import { getDashboardDb } from "../db/dashboard.ts";
import type { Insight } from "./types.ts";

export type AutoApplyTier = "auto" | "review" | "off";
export type RiskTier = AutoApplyTier | "none";

export const AUTOAPPLY_POLICY_KEY = "autoapply.policy";

export const SAFE_AUTO_ACTIONS: ReadonlySet<string> = new Set<string>([
  "start-job:model-health:all",
  "start-job:infra:doctor-log-rotate",
]);

export const MODEL_PROBE_POLICY_KEY = "probe:model:*";

export const COOLDOWN_CLEAR_POLICY_KEY = "clear-cooldown:model:*";

// Promoted 2026-07-05 (ULTRAPLAN P2.4) — see docs/AUTOAPPLY_PROMOTION_REVIEW.md.
// Retrying a timed-out builder pass is non-destructive: reasonerApplyPlaybookHandler
// -> applyPlaybookAction("retry-continuation") -> startWorkflowRun() creates a NEW
// run (old runs/passes/diagnoses intact; the project lock makes a concurrent retry
// fail cleanly). The created run id is recorded in reasoner_playbook_runs and in the
// auto-apply audit row, and the run can be cancelled via POST /api/builder/runs/:id/cancel.
// NOTE: the other three SPEC-10 candidates (start-job:doctor:scan and the two
// start-job:service:mimule-* restarts) FAILED implementation verification and were
// refused — the review doc has the evidence. Do not add them here without re-verifying.
export const PASS_TIMEOUT_RETRY_POLICY_KEY = "reasoner-remediate:pass-timeout";

// ── Rollback-evidence affordances for auto-tier actions ─────────────────────
// Structural requirement (SPEC 10): an auto-tier action may only execute
// unattended when we can say, declaratively, what its rollback affordance is —
// either a concrete rollback path with recorded target ids, or an explicit
// read-only/diagnostic marker (rollback is vacuous by design). Auto-tier
// actions WITHOUT an entry here are skipped by autoApplySafeInsights with the
// audited reason `autoapply.skipped-no-rollback` and left for operator review.
// This map is the single source of truth, keyed by policyKeyForAction(actionId);
// keep it next to SAFE_AUTO_ACTIONS so promotions and their rollback evidence
// are reviewed together (docs/AUTOAPPLY_PROMOTION_REVIEW.md).
export type AutoApplyRollbackAffordance =
  | { kind: "read-only"; note: string }
  | { kind: "rollback"; rollbackHint: string; recordedIds: string };

export const AUTO_ROLLBACK_AFFORDANCES: Readonly<Record<string, AutoApplyRollbackAffordance>> = {
  "start-job:model-health:all": {
    kind: "read-only",
    note: "Diagnostic probe: re-observes every model and refreshes the model-health snapshot. It changes no policy or routing rule itself; restoring the stale snapshot would be anti-remediation, so rollback is vacuous by design.",
  },
  "start-job:infra:doctor-log-rotate": {
    kind: "rollback",
    rollbackHint: "Restore /var/lib/mimule/doctor-log.jsonl from the timestamped .jsonl.gz archive recorded in the action result (gunzip it back in place).",
    recordedIds: "archive path in the audited action result message",
  },
  [MODEL_PROBE_POLICY_KEY]: {
    kind: "read-only",
    note: "Diagnostic single-model probe: re-observes one model with fallbacks disabled and refreshes only that model's health row. It changes no policy or routing rule by itself.",
  },
  [COOLDOWN_CLEAR_POLICY_KEY]: {
    kind: "rollback",
    rollbackHint: "If clearing the cooldown was wrong, re-block the model with mutate-policy:model:<model>:block; the model id is the third segment of the audited actionId.",
    recordedIds: "model id in the audited actionId",
  },
  [PASS_TIMEOUT_RETRY_POLICY_KEY]: {
    kind: "rollback",
    rollbackHint: "Cancel the retried run via POST /api/builder/runs/<runId>/cancel; the created run id is in the auto-apply audit resultJson and in reasoner_playbook_runs.result.",
    recordedIds: "created builder run id(s) from the playbook results",
  },
};

export function rollbackAffordanceForAction(actionId: string | null | undefined): AutoApplyRollbackAffordance | null {
  if (!actionId) return null;
  return AUTO_ROLLBACK_AFFORDANCES[policyKeyForAction(actionId)] ?? null;
}

export interface AutoApplyPolicy {
  tiers: Record<string, AutoApplyTier>;
  maxAutoAppliesPerHour: number;
  circuitBreakerThreshold: number;
  circuitBreakerWindowMs: number;
  minAiConfidenceForAutoApply: number;
}

const DEFAULT_POLICY: AutoApplyPolicy = {
  tiers: {},
  maxAutoAppliesPerHour: 10,
  circuitBreakerThreshold: 3,
  circuitBreakerWindowMs: 60 * 60_000,
  minAiConfidenceForAutoApply: 0.75,
};

function parsePolicy(value: string | null | undefined): AutoApplyPolicy {
  if (!value) return { ...DEFAULT_POLICY, tiers: {} };
  try {
    const parsed = JSON.parse(value) as Partial<AutoApplyPolicy>;
    const tiers: Record<string, AutoApplyTier> = {};
    for (const [key, tier] of Object.entries(parsed.tiers ?? {})) {
      if (tier === "auto" || tier === "review" || tier === "off") tiers[key] = tier;
    }
    const maxAutoAppliesPerHour = Number(parsed.maxAutoAppliesPerHour);
    const circuitBreakerThreshold = Number(parsed.circuitBreakerThreshold);
    const circuitBreakerWindowMs = Number(parsed.circuitBreakerWindowMs);
    const minAiConfidenceForAutoApply = Number(parsed.minAiConfidenceForAutoApply);
    return {
      tiers,
      maxAutoAppliesPerHour: Number.isFinite(maxAutoAppliesPerHour) && maxAutoAppliesPerHour > 0
        ? Math.min(100, Math.floor(maxAutoAppliesPerHour))
        : DEFAULT_POLICY.maxAutoAppliesPerHour,
      circuitBreakerThreshold: Number.isFinite(circuitBreakerThreshold) && circuitBreakerThreshold > 0
        ? Math.min(20, Math.floor(circuitBreakerThreshold))
        : DEFAULT_POLICY.circuitBreakerThreshold,
      circuitBreakerWindowMs: Number.isFinite(circuitBreakerWindowMs) && circuitBreakerWindowMs >= 60_000
        ? Math.min(24 * 60 * 60_000, Math.floor(circuitBreakerWindowMs))
        : DEFAULT_POLICY.circuitBreakerWindowMs,
      minAiConfidenceForAutoApply: Number.isFinite(minAiConfidenceForAutoApply)
        ? Math.max(0, Math.min(1, minAiConfidenceForAutoApply))
        : DEFAULT_POLICY.minAiConfidenceForAutoApply,
    };
  } catch {
    return { ...DEFAULT_POLICY, tiers: {} };
  }
}

export function loadAutoApplyPolicy(): AutoApplyPolicy {
  const db = getDashboardDb();
  if (!db) return { ...DEFAULT_POLICY, tiers: {} };
  try {
    const row = db.query("SELECT value_json FROM system_configs WHERE key = ?")
      .get(AUTOAPPLY_POLICY_KEY) as { value_json: string } | null;
    return parsePolicy(row?.value_json);
  } catch {
    return { ...DEFAULT_POLICY, tiers: {} };
  }
}

export function saveAutoApplyPolicy(policy: AutoApplyPolicy, changedBy: string, note?: string): void {
  const db = getDashboardDb();
  if (!db) return;
  const now = Date.now();
  const existing = db.query("SELECT value_json FROM system_configs WHERE key = ?")
    .get(AUTOAPPLY_POLICY_KEY) as { value_json: string } | null;
  const valueJson = JSON.stringify(policy);
  db.query(`
    INSERT OR REPLACE INTO system_configs (key, value_json, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
  `).run(AUTOAPPLY_POLICY_KEY, valueJson, now, changedBy);
  db.query(`
    INSERT INTO config_changes (ts, key, old_value_json, new_value_json, changed_by, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(now, AUTOAPPLY_POLICY_KEY, existing?.value_json ?? null, valueJson, changedBy, note ?? null);
}

export function setAutoApplyTier(key: string, tier: AutoApplyTier, changedBy: string): AutoApplyPolicy {
  const policy = loadAutoApplyPolicy();
  policy.tiers[key] = tier;
  saveAutoApplyPolicy(policy, changedBy, `Set ${key} to ${tier}`);
  return policy;
}

export function policyKeyForAction(actionId: string): string {
  if (actionId.startsWith("reasoner-remediate:")) {
    const [, playbookId] = actionId.split(":");
    return `reasoner-remediate:${playbookId ?? ""}`;
  }
  if (actionId.startsWith("clear-cooldown:model:") || (actionId.startsWith("mutate-policy:model:") && actionId.endsWith(":cooldown-clear"))) {
    return COOLDOWN_CLEAR_POLICY_KEY;
  }
  if (actionId.startsWith("probe:model:")) return MODEL_PROBE_POLICY_KEY;
  return actionId;
}

export function defaultTierForAction(actionId: string | null | undefined): RiskTier {
  if (!actionId) return "none";
  if (SAFE_AUTO_ACTIONS.has(actionId)) return "auto";
  // probe:model is a read-only diagnostic, but auto-promotion still requires the
  // gate (docs/AUTOAPPLY_PROMOTION_REVIEW.md entry + operator OK), which it has NOT
  // passed yet. Ship at review tier; flip to "auto" only when that gate clears.
  if (actionId.startsWith("probe:model:")) return "review";
  if (actionId.startsWith("clear-cooldown:model:") || (actionId.startsWith("mutate-policy:model:") && actionId.endsWith(":cooldown-clear"))) return "auto";
  // Promoted family (mirrors the cooldown-clear precedent): every
  // reasoner-remediate:pass-timeout:<workflowId>:<passId>[:<incidentId>] action
  // normalizes to PASS_TIMEOUT_RETRY_POLICY_KEY. Other playbooks stay review.
  // See docs/AUTOAPPLY_PROMOTION_REVIEW.md for the verified rollback affordance.
  if (policyKeyForAction(actionId) === PASS_TIMEOUT_RETRY_POLICY_KEY) return "auto";
  return "review";
}

export function tierForAction(actionId: string | null | undefined): RiskTier {
  if (!actionId) return "none";
  const policy = loadAutoApplyPolicy();
  const exact = policy.tiers[actionId];
  if (exact) return exact;
  const normalized = policy.tiers[policyKeyForAction(actionId)];
  if (normalized) return normalized;
  return defaultTierForAction(actionId);
}

export function tierForRegistryKey(key: string, actionDescriptorId?: string | null): AutoApplyTier {
  const policy = loadAutoApplyPolicy();
  const override = policy.tiers[key] ?? (actionDescriptorId ? policy.tiers[actionDescriptorId] : undefined);
  if (override) return override;
  const fallback = defaultTierForAction(actionDescriptorId ?? key);
  return fallback === "none" ? "off" : fallback;
}

export function isSafeAutoAction(actionId: string | null | undefined): boolean {
  return tierForAction(actionId) === "auto";
}

export function riskTierFor(insight: Pick<Insight, "actionDescriptorId">): RiskTier {
  return tierForAction(insight.actionDescriptorId);
}
