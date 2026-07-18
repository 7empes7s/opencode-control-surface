import { expect, test } from "bun:test";
import { deriveHealthState, healthBucket, type HealthSignals, type HealthState } from "./modelHealthState.ts";

test("live: a fast successful probe is healthy", () => {
  const verdict = deriveHealthState({ probeCode: 200, probeMs: 1_100, recentCalls: 1_557, recentSuccesses: 1_477 });
  expect(verdict).toMatchObject({ state: "live", bucket: "healthy" });
  expect(verdict.reason).toContain("1477/1557");
});

test("limited: a 429 is healthy only when recent traffic succeeded", () => {
  const verdict = deriveHealthState({ probeCode: 429, probeMs: 120, recentCalls: 80, recentSuccesses: 25, recentRateLimitErrors: 55 });
  expect(verdict).toMatchObject({ state: "limited", bucket: "healthy" });
  expect(verdict.reason).toContain("throttled, not dead");

  expect(deriveHealthState({ probeCode: 429, probeMs: 120, recentCalls: 5, recentSuccesses: 0, recentRateLimitErrors: 5 }).state).toBe("unknown");
});

test("slow: a successful probe from five to thirty seconds is healthy but slow", () => {
  const verdict = deriveHealthState({ probeCode: 200, probeMs: 9_862 });
  expect(verdict).toMatchObject({ state: "slow", bucket: "healthy" });
  expect(verdict.reason).toContain("9.9s");
});

test("slow: ledger latency needs successful traffic and no contrary probe", () => {
  expect(deriveHealthState({
    recentCalls: 5,
    recentSuccesses: 2,
    recentAvgLatencyMs: 7_500,
  }).state).toBe("slow");
  expect(deriveHealthState({
    recentCalls: 5,
    recentSuccesses: 0,
    recentAuthErrors: 5,
    recentAvgLatencyMs: 7_500,
  }).state).toBe("unknown");
  expect(deriveHealthState({
    probeCode: 403,
    recentCalls: 5,
    recentSuccesses: 2,
    recentAvgLatencyMs: 7_500,
  }).state).toBe("unknown");
});

test("degraded: the Minimax earned-history shape needs credential recovery", () => {
  const verdict = deriveHealthState({
    allTimeCalls: 526,
    allTimeSuccesses: 425,
    recentCalls: 10,
    recentSuccesses: 0,
    recentAuthErrors: 10,
  });
  expect(verdict).toMatchObject({ state: "degraded", bucket: "unhealthy" });
  expect(verdict.reason).toContain("earned 80.8% over 526 calls");
  expect(verdict.reason).toContain("likely an expired credential");
});

test("dead: an unproven route at zero percent over twenty recent calls is unhealthy", () => {
  const verdict = deriveHealthState({
    allTimeCalls: 55,
    allTimeSuccesses: 0,
    recentCalls: 55,
    recentSuccesses: 0,
    recentRateLimitErrors: 46,
  });
  expect(verdict).toMatchObject({ state: "dead", bucket: "unhealthy" });
  expect(verdict.reason).toContain("46 rate-limits");
});

test("dead: a hard 400, 404, or 410 probe is dead only without earned history", () => {
  expect(deriveHealthState({ probeCode: 404, probeMs: 100 }).state).toBe("dead");
  expect(deriveHealthState({ probeCode: 410, probeMs: 100 }).state).toBe("dead");
  expect(deriveHealthState({ probeCode: 404, probeMs: 100, allTimeCalls: 100, allTimeSuccesses: 80 }).state).toBe("unknown");
});

test("hang: timeout-like probe codes need three consecutive misses", () => {
  expect(deriveHealthState({ probeCode: 0, probeMs: 30_000, probeStreak: 2 }).state).not.toBe("hang");
  const zeroVerdict = deriveHealthState({ probeCode: 0, probeMs: 30_000, probeStreak: 3 });
  expect(zeroVerdict).toMatchObject({ state: "hang", bucket: "unhealthy" });
  expect(zeroVerdict.reason).toContain("3× consecutive");
  expect(deriveHealthState({ probeCode: null, probeStreak: 3 }).state).toBe("hang");
  expect(deriveHealthState({ probeCode: 408, probeMs: 20_000, probeStreak: 2 }).state).not.toBe("hang");
  expect(deriveHealthState({ probeCode: 408, probeMs: 20_000, probeStreak: 3 }).state).toBe("hang");
});

test("unknown: absent probe and ledger evidence never fabricates liveness", () => {
  const verdict = deriveHealthState({ available: true });
  expect(verdict).toMatchObject({ state: "unknown", bucket: "unknown" });
  expect(verdict.reason).toContain("no probe entry and no ledger calls");
});

test("infra artifacts excluded upstream cannot manufacture degraded", () => {
  const verdict = deriveHealthState({
    allTimeCalls: 526,
    allTimeSuccesses: 425,
    recentCalls: 0,
    recentSuccesses: 0,
    recentAuthErrors: 0,
    recentRateLimitErrors: 0,
  });
  expect(verdict.state).toBe("unknown");
});

test("precedence: degraded earned history outranks a simultaneous hang", () => {
  const verdict = deriveHealthState({
    probeCode: 0,
    probeStreak: 3,
    allTimeCalls: 526,
    allTimeSuccesses: 425,
    recentCalls: 10,
    recentSuccesses: 0,
    recentAuthErrors: 10,
  });
  expect(verdict.state).toBe("degraded");
});

test("exact threshold boundaries are honored", () => {
  expect(deriveHealthState({ allTimeCalls: 50, allTimeSuccesses: 30, recentCalls: 5, recentSuccesses: 0, recentRateLimitErrors: 5 }).state).toBe("degraded");
  expect(deriveHealthState({ allTimeCalls: 49, allTimeSuccesses: 49, recentCalls: 20, recentSuccesses: 0 }).state).toBe("dead");
  expect(deriveHealthState({ probeCode: 200, probeMs: 4_999 }).state).toBe("live");
  expect(deriveHealthState({ probeCode: 200, probeMs: 5_000 }).state).toBe("slow");
  expect(deriveHealthState({ probeCode: 200, probeMs: 30_000 }).state).toBe("unknown");
});

test("malformed and NaN signals degrade to unknown without throwing", () => {
  const malformed = {
    probeCode: Number.NaN,
    probeMs: Number.POSITIVE_INFINITY,
    probeStreak: -1,
    recentCalls: "20",
    recentSuccesses: Number.NaN,
    allTimeCalls: 50,
    allTimeSuccesses: 60,
  } as unknown as HealthSignals;
  expect(() => deriveHealthState(malformed)).not.toThrow();
  expect(deriveHealthState(malformed).state).toBe("unknown");
  expect(deriveHealthState(null as unknown as HealthSignals).state).toBe("unknown");
});

test("healthBucket maps all seven states", () => {
  const expected: Record<HealthState, ReturnType<typeof healthBucket>> = {
    live: "healthy",
    limited: "healthy",
    slow: "healthy",
    degraded: "unhealthy",
    dead: "unhealthy",
    hang: "unhealthy",
    unknown: "unknown",
  };
  for (const [state, bucket] of Object.entries(expected) as Array<[HealthState, typeof expected[HealthState]]>) {
    expect(healthBucket(state)).toBe(bucket);
  }
});
