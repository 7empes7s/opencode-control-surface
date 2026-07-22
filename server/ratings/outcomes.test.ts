import { describe, expect, test } from "bun:test";
import {
  computeOutcomeLeaderboard,
  type OutcomeBuilderPassRow,
  type OutcomeGatewayCallRow,
} from "./outcomes.ts";

const NOW = 1_700_000_000_000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function pass(overrides: Partial<OutcomeBuilderPassRow> = {}): OutcomeBuilderPassRow {
  return {
    model: "builder-model",
    provider: "opencode",
    status: "success",
    startedAt: NOW - 1_000,
    finishedAt: NOW,
    failureClass: null,
    ...overrides,
  };
}

function call(overrides: Partial<OutcomeGatewayCallRow> = {}): OutcomeGatewayCallRow {
  return {
    resolvedModel: "traffic-model",
    ts: NOW - 1_000,
    latencyMs: 100,
    costEstimateUsd: 0.01,
    success: 1,
    errorClass: null,
    ...overrides,
  };
}

function model(
  rows: ReturnType<typeof computeOutcomeLeaderboard>,
  name: string,
): ReturnType<typeof computeOutcomeLeaderboard>["models"][number] {
  const result = rows.models.find((entry) => entry.model === name);
  if (!result) throw new Error(`missing ${name}`);
  return result;
}

describe("computeOutcomeLeaderboard", () => {
  const sampleRailCases = [
    { label: "n=4 returns insufficient data", n: 4, expected: "insufficient-data" as const },
    { label: "n=5 returns a numeric success rate", n: 5, expected: 100 },
  ];

  for (const row of sampleRailCases) {
    test(`minimum-sample rail: ${row.label}`, () => {
      const leaderboard = computeOutcomeLeaderboard({
        builderPasses: Array.from({ length: row.n }, () => pass()),
        gatewayCalls: [],
      }, NOW, "7d");
      expect(model(leaderboard, "builder-model").task.successRate).toBe(row.expected);
    });
  }

  test("excludes canceled builder passes from the denominator and failure mix", () => {
    const leaderboard = computeOutcomeLeaderboard({
      builderPasses: [
        ...Array.from({ length: 4 }, () => pass()),
        pass({ status: "failed", failureClass: "validation" }),
        pass({ status: "canceled", failureClass: "operator-stop" }),
      ],
      gatewayCalls: [],
    }, NOW, "7d");
    const task = model(leaderboard, "builder-model").task;
    expect(task.n).toBe(5);
    expect(task.successRate).toBe(80);
    expect(task.failureClasses).toEqual({ validation: 1 });
  });

  test("filters each telemetry axis to the requested recency window", () => {
    const leaderboard = computeOutcomeLeaderboard({
      builderPasses: [
        pass({ model: "inside-task", startedAt: NOW - SEVEN_DAYS + 1 }),
        pass({ model: "outside-task", startedAt: NOW - SEVEN_DAYS - 1 }),
      ],
      gatewayCalls: [
        call({ resolvedModel: "inside-traffic", ts: NOW - SEVEN_DAYS + 1 }),
        call({ resolvedModel: "outside-traffic", ts: NOW - SEVEN_DAYS - 1 }),
      ],
    }, NOW, "7d");
    expect(leaderboard.models.map((entry) => entry.model).sort()).toEqual(["inside-task", "inside-traffic"]);
  });

  test("calculates p50 and p95 from a known latency array", () => {
    const leaderboard = computeOutcomeLeaderboard({
      builderPasses: [],
      gatewayCalls: [10, 20, 30, 40, 50].map((latencyMs) => call({ latencyMs })),
    }, NOW, "7d");
    const traffic = model(leaderboard, "traffic-model").traffic;
    expect(traffic.p50LatencyMs).toBe(30);
    expect(traffic.p95LatencyMs).toBe(48);
  });

  test("keeps a dead last-7d model distinct from its historical all-time rate", () => {
    const historicSuccesses = Array.from({ length: 101 }, () => call({
      resolvedModel: "coding-go-minimax-m3",
      ts: NOW - SEVEN_DAYS - 1,
      success: 1,
    }));
    const historicFailures = Array.from({ length: 19 }, () => call({
      resolvedModel: "coding-go-minimax-m3",
      ts: NOW - SEVEN_DAYS - 1,
      success: 0,
      errorClass: "timeout",
    }));
    const recentFailures = Array.from({ length: 5 }, () => call({
      resolvedModel: "coding-go-minimax-m3",
      ts: NOW - 1_000,
      success: 0,
      errorClass: "auth",
    }));
    const rows = { builderPasses: [], gatewayCalls: [...historicSuccesses, ...historicFailures, ...recentFailures] };

    const recent = model(computeOutcomeLeaderboard(rows, NOW, "7d"), "coding-go-minimax-m3").traffic;
    const allTime = model(computeOutcomeLeaderboard(rows, NOW, "all"), "coding-go-minimax-m3").traffic;
    expect(recent.successRate).toBe(0);
    expect(allTime.successRate).toBeCloseTo(80.8, 6);
  });
});
