import { getDashboardDb } from "../db/dashboard.ts";
import type { Insight } from "./types.ts";

export type AutoApplyTier = "auto" | "review" | "off";
export type RiskTier = AutoApplyTier | "none";

export const AUTOAPPLY_POLICY_KEY = "autoapply.policy";

export const SAFE_AUTO_ACTIONS: ReadonlySet<string> = new Set<string>([
  "start-job:model-health:all",
  "start-job:infra:doctor-log-rotate",
]);

export const COOLDOWN_CLEAR_POLICY_KEY = "mutate-policy:model:*:cooldown-clear";

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
  if (actionId.startsWith("mutate-policy:model:") && actionId.endsWith(":cooldown-clear")) {
    return COOLDOWN_CLEAR_POLICY_KEY;
  }
  return actionId;
}

export function defaultTierForAction(actionId: string | null | undefined): RiskTier {
  if (!actionId) return "none";
  if (SAFE_AUTO_ACTIONS.has(actionId)) return "auto";
  if (actionId.startsWith("mutate-policy:model:") && actionId.endsWith(":cooldown-clear")) return "auto";
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
