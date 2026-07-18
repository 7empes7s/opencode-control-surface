const EARNED_MIN_CALLS = 50;
const EARNED_MIN_RATE = 0.60;
const DEGRADED_RECENT_FLOOR = 5;
const DEAD_RECENT_FLOOR = 20;
const SLOW_MS_LO = 5000;
const SLOW_MS_HI = 30000;
const HANG_STREAK = 3;

export type HealthState = "live" | "limited" | "slow" | "degraded" | "dead" | "hang" | "unknown";
export type HealthBucket = "healthy" | "unhealthy" | "unknown";

export interface HealthSignals {
  probeCode?: number | null;
  probeMs?: number | null;
  probeStreak?: number | null;
  recentCalls?: number;
  recentSuccesses?: number;
  recentAuthErrors?: number;
  recentRateLimitErrors?: number;
  recentAvgLatencyMs?: number | null;
  allTimeCalls?: number;
  allTimeSuccesses?: number;
  available?: boolean | null;
}

export interface HealthVerdict {
  state: HealthState;
  bucket: HealthBucket;
  reason: string;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validCountPair(callsValue: unknown, successesValue: unknown): { calls: number; successes: number } | null {
  const calls = finiteNonNegative(callsValue);
  const successes = finiteNonNegative(successesValue);
  if (calls === undefined || successes === undefined || successes > calls) return null;
  return { calls, successes };
}

function formatPercent(successes: number, calls: number): string {
  return ((successes / calls) * 100).toFixed(1).replace(/\.0$/, "");
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1).replace(/\.0$/, "");
}

function verdict(state: HealthState, reason: string): HealthVerdict {
  return { state, bucket: healthBucket(state), reason };
}

export function deriveHealthState(signals: HealthSignals): HealthVerdict {
  const s = signals && typeof signals === "object" ? signals : {} as HealthSignals;
  const rawProbeCode = s.probeCode;
  const numericProbeCode = finiteNonNegative(rawProbeCode);
  const hasProbeCode = rawProbeCode === null || numericProbeCode !== undefined;
  const probeCode = rawProbeCode === null ? null : numericProbeCode;
  const probeMs = finiteNonNegative(s.probeMs);
  const probeStreak = finiteNonNegative(s.probeStreak);
  const recent = validCountPair(s.recentCalls, s.recentSuccesses);
  const allTime = validCountPair(s.allTimeCalls, s.allTimeSuccesses);
  const recentAuthErrorsRaw = finiteNonNegative(s.recentAuthErrors);
  const recentRateLimitErrorsRaw = finiteNonNegative(s.recentRateLimitErrors);
  const recentAuthErrors = recent && recentAuthErrorsRaw !== undefined && recentAuthErrorsRaw <= recent.calls
    ? recentAuthErrorsRaw
    : 0;
  const recentRateLimitErrors = recent && recentRateLimitErrorsRaw !== undefined && recentRateLimitErrorsRaw <= recent.calls
    ? recentRateLimitErrorsRaw
    : 0;
  const recentAvgLatencyMs = s.recentAvgLatencyMs === null ? null : finiteNonNegative(s.recentAvgLatencyMs);
  const earned = Boolean(
    allTime
    && allTime.calls >= EARNED_MIN_CALLS
    && allTime.calls > 0
    && (allTime.successes / allTime.calls) >= EARNED_MIN_RATE,
  );
  const earnedRate = allTime && allTime.calls > 0 ? formatPercent(allTime.successes, allTime.calls) : "0";
  const hardCredentialProbe = probeCode === 401 || probeCode === 402 || probeCode === 403;
  const recentCredentialOrQuotaFailure = Boolean(
    recent
    && recent.calls >= DEGRADED_RECENT_FLOOR
    && recent.successes === 0
    && (recentAuthErrors > 0 || recentRateLimitErrors > 0),
  );

  // Precedence is intentional: a route that earned a working record needs
  // recovery, even when its newest probe also looks like a hang.
  if (earned && (recentCredentialOrQuotaFailure || hardCredentialProbe)) {
    const prefix = `earned ${earnedRate}% over ${allTime!.calls} calls`;
    if (recentCredentialOrQuotaFailure) {
      if (recentAuthErrors >= recentRateLimitErrors && recentAuthErrors > 0) {
        return verdict("degraded", `${prefix}, now 0/${recent!.calls} in 7d on auth errors — likely an expired credential`);
      }
      return verdict("degraded", `${prefix}, now 0/${recent!.calls} in 7d on rate-limit errors — likely a quota or throttling failure`);
    }
    return verdict("degraded", `${prefix}, now probe ${probeCode} — likely an expired credential or quota`);
  }

  if ((probeCode === 0 || probeCode === null) && probeStreak !== undefined && probeStreak >= HANG_STREAK) {
    const timeoutMs = probeMs !== undefined && probeMs > 0 ? probeMs : SLOW_MS_HI;
    return verdict("hang", `no answer in ${formatSeconds(timeoutMs)}s, ${probeStreak}× consecutive`);
  }

  const hardDeadProbe = probeCode === 400 || probeCode === 404;
  const recentDead = Boolean(recent && recent.calls >= DEAD_RECENT_FLOOR && recent.successes === 0);
  if (!earned && (hardDeadProbe || recentDead)) {
    if (recentDead) {
      const otherErrors = Math.max(0, recent!.calls - recentAuthErrors - recentRateLimitErrors);
      const detail = recentRateLimitErrors >= recentAuthErrors && recentRateLimitErrors >= otherErrors && recentRateLimitErrors > 0
        ? `${recentRateLimitErrors} rate-limits`
        : recentAuthErrors >= otherErrors && recentAuthErrors > 0
          ? `${recentAuthErrors} auth errors`
          : `${otherErrors} other errors`;
      return verdict("dead", `0/${recent!.calls} in 7d, ${detail}, never earned a working record`);
    }
    return verdict("dead", `probe returned ${probeCode}; never earned a working record`);
  }

  if (probeCode === 429 && recent && recent.successes >= 1) {
    return verdict("limited", `rate-limited (429) but ${recent.successes}/${recent.calls} succeeded this week — throttled, not dead`);
  }

  const probeAllowsLedgerHealth = !hasProbeCode || probeCode === 200;
  const slowProbe = probeCode === 200 && probeMs !== undefined && probeMs >= SLOW_MS_LO && probeMs < SLOW_MS_HI;
  const slowLedger = Boolean(
    probeAllowsLedgerHealth
    && recent
    && recent.successes > 0
    && recentAvgLatencyMs !== undefined
    && recentAvgLatencyMs !== null
    && recentAvgLatencyMs >= SLOW_MS_LO,
  );
  if (slowProbe || slowLedger) {
    const latencyMs = slowProbe ? probeMs! : recentAvgLatencyMs!;
    const source = slowProbe ? "probe" : "7d average";
    return verdict("slow", `${source} responds in ${formatSeconds(latencyMs)}s — slow but working`);
  }

  const fastProbe = probeCode === 200 && probeMs !== undefined && probeMs < SLOW_MS_LO;
  const recentSuccess = Boolean(recent && recent.calls > 0 && recent.successes > 0);
  if (fastProbe || (recentSuccess && probeAllowsLedgerHealth)) {
    if (fastProbe && recentSuccess) {
      return verdict("live", `200 in ${formatSeconds(probeMs!)}s; ${recent!.successes}/${recent!.calls} this week`);
    }
    if (fastProbe) return verdict("live", `200 in ${formatSeconds(probeMs!)}s — reachable and fast`);
    return verdict("live", `${recent!.successes}/${recent!.calls} succeeded in 7d`);
  }

  const hasLedgerRows = Boolean((recent && recent.calls > 0) || (allTime && allTime.calls > 0));
  if (!hasProbeCode && !hasLedgerRows) {
    const modelHealthNote = typeof s.available === "boolean" ? `; model-health says ${s.available ? "available" : "unavailable"} without independent evidence` : "";
    return verdict("unknown", `no probe entry and no ledger calls — not yet observed${modelHealthNote}`);
  }
  if (probeCode === 429 && (!recent || recent.successes === 0)) {
    return verdict("unknown", "probe is rate-limited but no successful ledger call proves it is still serving");
  }
  return verdict("unknown", "observed signals are insufficient for a confident health state");
}

export function healthBucket(state: HealthState): HealthBucket {
  if (state === "live" || state === "limited" || state === "slow") return "healthy";
  if (state === "degraded" || state === "dead" || state === "hang") return "unhealthy";
  return "unknown";
}
