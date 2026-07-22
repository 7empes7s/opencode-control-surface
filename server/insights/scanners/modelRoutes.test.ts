import { describe, expect, test } from "bun:test";
import {
  BROKEN_PAID_MAX_SUCCESS_RATE,
  DEAD_ROUTE_MIN_CALLS,
  DEGRADED_ALL_TIME_MIN_CALLS,
  HEALTHY_BUILDER_MIN_PASSES,
  PROBE_ONLY_CALLS,
  deriveRouteAdvisories,
  mapModelRouteFindings,
  type BuilderCapabilityStat,
  type ModelRouteStat,
  type ModelRouteStats,
} from "./modelRoutes.ts";

const NOW = 1_700_000_000_000;

function route(overrides: Partial<ModelRouteStat> = {}): ModelRouteStat {
  return {
    routeName: "route-under-test",
    allCalls: 0,
    allSuccesses: 0,
    recentCalls: 0,
    recentSuccesses: 0,
    recentDistinctDays: 0,
    recentPaidCalls: 0,
    dominantRecentErrorClass: null,
    ...overrides,
  };
}

function capability(overrides: Partial<BuilderCapabilityStat> = {}): BuilderCapabilityStat {
  return {
    provider: "opencode",
    model: "opencode-go/kimi-k2.6",
    passes: 0,
    successes: 0,
    ...overrides,
  };
}

function stats(routes: ModelRouteStat[] = [], builderCapabilities: BuilderCapabilityStat[] = []): ModelRouteStats {
  return { routes, builderCapabilities };
}

function hasDetector(input: ModelRouteStats, detector: string): boolean {
  return mapModelRouteFindings(input, NOW).some((finding) => finding.sourceKey?.startsWith(`models:${detector}:`));
}

describe("mapModelRouteFindings", () => {
  const routeCases: Array<{
    detector: string;
    label: string;
    input: ModelRouteStat;
    expected: boolean;
  }> = [
    {
      detector: "dead-route",
      label: "dead route at the minimum-call boundary",
      input: route({ allCalls: DEAD_ROUTE_MIN_CALLS, recentCalls: DEAD_ROUTE_MIN_CALLS, recentDistinctDays: 2 }),
      expected: true,
    },
    {
      detector: "dead-route",
      label: "dead route below the minimum-call boundary",
      input: route({ allCalls: DEAD_ROUTE_MIN_CALLS - 1, recentCalls: DEAD_ROUTE_MIN_CALLS - 1, recentDistinctDays: 2 }),
      expected: false,
    },
    {
      detector: "dead-route",
      label: "route with a recent success",
      input: route({ allCalls: DEAD_ROUTE_MIN_CALLS, allSuccesses: 1, recentCalls: DEAD_ROUTE_MIN_CALLS, recentSuccesses: 1 }),
      expected: false,
    },
    {
      detector: "probe-only-route",
      label: "exact failed probe batch on one UTC day",
      input: route({ allCalls: PROBE_ONLY_CALLS, recentCalls: PROBE_ONLY_CALLS, recentDistinctDays: 1 }),
      expected: true,
    },
    {
      detector: "probe-only-route",
      label: "failed probe batch spread across two UTC days",
      input: route({ allCalls: PROBE_ONLY_CALLS, recentCalls: PROBE_ONLY_CALLS, recentDistinctDays: 2 }),
      expected: false,
    },
    {
      detector: "probe-only-route",
      label: "former traffic route with only five recent probe failures",
      input: route({ allCalls: PROBE_ONLY_CALLS + 1, recentCalls: PROBE_ONLY_CALLS, recentDistinctDays: 1 }),
      expected: false,
    },
    {
      detector: "degraded-route",
      label: "formerly healthy route at both thresholds",
      input: route({
        allCalls: DEGRADED_ALL_TIME_MIN_CALLS,
        allSuccesses: 30,
        recentCalls: DEAD_ROUTE_MIN_CALLS,
        recentDistinctDays: 2,
        dominantRecentErrorClass: "auth",
      }),
      expected: true,
    },
    {
      detector: "degraded-route",
      label: "formerly healthy route below the all-time call threshold",
      input: route({
        allCalls: DEGRADED_ALL_TIME_MIN_CALLS - 1,
        allSuccesses: 30,
        recentCalls: DEAD_ROUTE_MIN_CALLS,
      }),
      expected: false,
    },
    {
      detector: "degraded-route",
      label: "route just below the all-time success-rate threshold",
      input: route({
        allCalls: DEGRADED_ALL_TIME_MIN_CALLS,
        allSuccesses: 29,
        recentCalls: DEAD_ROUTE_MIN_CALLS,
      }),
      expected: false,
    },
    {
      detector: "broken-paid-fallback",
      label: "paid auth-broken route below the success-rate threshold",
      input: route({ allCalls: 10, recentCalls: 10, recentPaidCalls: 1, dominantRecentErrorClass: "auth" }),
      expected: true,
    },
    {
      detector: "broken-paid-fallback",
      label: "paid route exactly at the excluded success-rate boundary",
      input: route({
        allCalls: 10,
        allSuccesses: BROKEN_PAID_MAX_SUCCESS_RATE * 10,
        recentCalls: 10,
        recentSuccesses: BROKEN_PAID_MAX_SUCCESS_RATE * 10,
        recentPaidCalls: 1,
        dominantRecentErrorClass: "auth",
      }),
      expected: false,
    },
    {
      detector: "broken-paid-fallback",
      label: "free failed route",
      input: route({ allCalls: 10, recentCalls: 10, dominantRecentErrorClass: "auth" }),
      expected: false,
    },
    {
      detector: "broken-paid-fallback",
      label: "paid route with a non-auth dominant error",
      input: route({ allCalls: 10, recentCalls: 10, recentPaidCalls: 1, dominantRecentErrorClass: "rate_limit" }),
      expected: false,
    },
  ];

  for (const row of routeCases) {
    test(`${row.detector}: ${row.label}`, () => {
      expect(hasDetector(stats([row.input]), row.detector)).toBe(row.expected);
    });
  }

  const orphanCases: Array<{
    label: string;
    input: ModelRouteStats;
    expected: boolean;
  }> = [
    {
      label: "healthy builder capability at both thresholds without a working route",
      input: stats([], [capability({ passes: HEALTHY_BUILDER_MIN_PASSES, successes: 6 })]),
      expected: true,
    },
    {
      label: "builder capability below the pass-count boundary",
      input: stats([], [capability({ passes: HEALTHY_BUILDER_MIN_PASSES - 1, successes: 6 })]),
      expected: false,
    },
    {
      label: "builder capability below the success-rate boundary",
      input: stats([], [capability({ passes: HEALTHY_BUILDER_MIN_PASSES, successes: 5 })]),
      expected: false,
    },
    {
      label: "builder capability with a matching successful gateway route",
      input: stats(
        [route({ routeName: "zen-kimi-k2-6", allCalls: 1, allSuccesses: 1 })],
        [capability({ passes: HEALTHY_BUILDER_MIN_PASSES, successes: 6 })],
      ),
      expected: false,
    },
  ];

  for (const row of orphanCases) {
    test(`orphaned-capability: ${row.label}`, () => {
      expect(hasDetector(row.input, "orphaned-capability")).toBe(row.expected);
    });
  }

  test("emits deterministic model insight metadata and degraded error evidence", () => {
    const findings = mapModelRouteFindings(stats([route({
      routeName: "historically-healthy",
      allCalls: 50,
      allSuccesses: 30,
      recentCalls: 5,
      recentDistinctDays: 2,
      dominantRecentErrorClass: "auth",
    })]), NOW);

    const degraded = findings.find((finding) => finding.sourceKey === "models:degraded-route:historically-healthy");
    expect(degraded).toMatchObject({
      domain: "models",
      severity: "high",
      actionDescriptorId: null,
      manualPageHref: "/models",
      createdAt: NOW,
    });
    expect(degraded?.plainSummary).toContain("Dominant recent error: auth");
    expect(findings.some((finding) => finding.sourceKey === "models:dead-route:historically-healthy")).toBe(false);
  });
});

describe("deriveRouteAdvisories", () => {
  test("sorts and prunes only dead routes while proposing healthy orphan capabilities", () => {
    const result = deriveRouteAdvisories(stats([
      route({ routeName: "z-dead", allCalls: 6, recentCalls: 6, recentDistinctDays: 2 }),
      route({ routeName: "a-dead", allCalls: 5, recentCalls: 5, recentDistinctDays: 2 }),
      route({
        routeName: "degraded-investigate",
        allCalls: 50,
        allSuccesses: 30,
        recentCalls: 5,
        recentDistinctDays: 2,
        dominantRecentErrorClass: "auth",
      }),
      route({ routeName: "zen-minimax-m2-7", allCalls: 2, allSuccesses: 1 }),
    ], [
      capability({ model: "opencode-go/kimi-k2.6", passes: 28, successes: 23 }),
      capability({ model: "opencode-go/minimax-m2.7", passes: 66, successes: 41 }),
    ]));

    expect(result.deadRoutes).toEqual(["a-dead", "z-dead"]);
    expect(result.orphanProposals).toEqual([{
      suggestion: "coding-go-kimi-k2-6 → hosted_vllm/kimi-k2.6",
      rationale: "opencode/opencode-go/kimi-k2.6 succeeded 23/28 builder passes, while no matching gateway route has recorded a success.",
    }]);
  });
});
