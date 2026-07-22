// First-party model outcome leaderboard (Catalog S5).
//
// This module intentionally only reads dashboard telemetry. The mapper is pure
// so its sample rail, recency rules, and percentile calculations stay testable
// without a database; the reader below merely supplies tenant-scoped rows.
import type {
  OutcomeAxisRate,
  OutcomeLeaderboard,
  OutcomeWindow,
} from "../api/types.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { whereTenant } from "../db/tenantScope.ts";

export const OUTCOME_WINDOWS: OutcomeWindow[] = ["7d", "30d", "all"];
export const DEFAULT_OUTCOME_WINDOW: OutcomeWindow = "7d";
export const MIN_OUTCOME_SAMPLE_SIZE = 5;

const WINDOW_MS: Record<Exclude<OutcomeWindow, "all">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export type OutcomeBuilderPassRow = {
  model: string | null;
  provider: string | null;
  status: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  failureClass: string | null;
};

export type OutcomeGatewayCallRow = {
  resolvedModel: string | null;
  ts: number | null;
  latencyMs: number | null;
  costEstimateUsd: number | null;
  success: number | boolean | null;
  errorClass: string | null;
};

export type OutcomeRows = {
  builderPasses: OutcomeBuilderPassRow[];
  gatewayCalls: OutcomeGatewayCallRow[];
};

type TaskAggregate = {
  n: number;
  successes: number;
  durations: number[];
  failureClasses: Record<string, number>;
  providers: Set<string>;
};

type TrafficAggregate = {
  n: number;
  successes: number;
  latencies: number[];
  totalCostUsd: number;
  errorClasses: Record<string, number>;
};

type BuilderDbRow = {
  model: string | null;
  provider: string | null;
  status: string | null;
  started_at: number | null;
  finished_at: number | null;
  failure_class: string | null;
};

type GatewayDbRow = {
  resolved_model: string | null;
  ts: number | null;
  latency_ms: number | null;
  cost_estimate_usd: number | null;
  success: number | null;
  error_class: string | null;
};

function emptyTaskAggregate(): TaskAggregate {
  return { n: 0, successes: 0, durations: [], failureClasses: {}, providers: new Set() };
}

function emptyTrafficAggregate(): TrafficAggregate {
  return { n: 0, successes: 0, latencies: [], totalCostUsd: 0, errorClasses: {} };
}

function increment(mix: Record<string, number>, value: string | null): void {
  const normalized = value?.trim();
  if (!normalized) return;
  mix[normalized] = (mix[normalized] ?? 0) + 1;
}

function isInWindow(timestamp: number | null, now: number, window: OutcomeWindow): boolean {
  if (window === "all") return true;
  return Number.isFinite(timestamp) && timestamp! >= now - WINDOW_MS[window];
}

function isFiniteNumber(value: number | null): value is number {
  return value != null && Number.isFinite(value);
}

function sampleRate(successes: number, n: number): OutcomeAxisRate {
  if (n < MIN_OUTCOME_SAMPLE_SIZE) return "insufficient-data";
  return n === 0 ? "insufficient-data" : (successes / n) * 100;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Linear interpolation keeps percentile values useful for small samples and is
// deterministic: p50 for [10,20,30,40,50] is 30 and p95 is 48.
export function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.max(0, Math.min(1, percentileValue));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function emptyLeaderboard(now: number, window: OutcomeWindow): OutcomeLeaderboard {
  return { window, generatedAt: now, models: [] };
}

export function normalizeOutcomeWindow(value: string | null | undefined): OutcomeWindow {
  return OUTCOME_WINDOWS.includes(value as OutcomeWindow)
    ? value as OutcomeWindow
    : DEFAULT_OUTCOME_WINDOW;
}

function leaderboardSort(
  a: OutcomeLeaderboard["models"][number],
  b: OutcomeLeaderboard["models"][number],
): number {
  const bestRate = (model: OutcomeLeaderboard["models"][number]): number => {
    const rates = [model.task.successRate, model.traffic.successRate]
      .filter((rate): rate is number => typeof rate === "number");
    return rates.length === 0 ? -1 : Math.max(...rates);
  };
  const rateDelta = bestRate(b) - bestRate(a);
  if (rateDelta !== 0) return rateDelta;
  const sampleDelta = (b.task.n + b.traffic.n) - (a.task.n + a.traffic.n);
  if (sampleDelta !== 0) return sampleDelta;
  return a.model.localeCompare(b.model);
}

// Pure aggregation over raw dashboard telemetry. The reader deliberately does
// no grouping so traffic percentiles can be computed and unit-tested here.
export function computeOutcomeLeaderboard(
  rows: OutcomeRows,
  now: number,
  window: OutcomeWindow,
): OutcomeLeaderboard {
  const taskByModel = new Map<string, TaskAggregate>();
  const trafficByModel = new Map<string, TrafficAggregate>();

  for (const pass of rows.builderPasses) {
    const model = pass.model?.trim();
    if (!model || pass.status === "canceled" || !isInWindow(pass.startedAt, now, window)) continue;

    const aggregate = taskByModel.get(model) ?? emptyTaskAggregate();
    aggregate.n += 1;
    if (pass.status === "success") aggregate.successes += 1;
    if (pass.status !== "success") increment(aggregate.failureClasses, pass.failureClass);
    if (pass.provider?.trim()) aggregate.providers.add(pass.provider.trim());
    if (isFiniteNumber(pass.startedAt) && isFiniteNumber(pass.finishedAt)) {
      aggregate.durations.push(pass.finishedAt - pass.startedAt);
    }
    taskByModel.set(model, aggregate);
  }

  for (const call of rows.gatewayCalls) {
    const model = call.resolvedModel?.trim();
    if (!model || !isInWindow(call.ts, now, window)) continue;

    const aggregate = trafficByModel.get(model) ?? emptyTrafficAggregate();
    aggregate.n += 1;
    if (call.success === 1 || call.success === true) aggregate.successes += 1;
    if (!(call.success === 1 || call.success === true)) increment(aggregate.errorClasses, call.errorClass);
    if (isFiniteNumber(call.latencyMs)) aggregate.latencies.push(call.latencyMs);
    if (isFiniteNumber(call.costEstimateUsd)) aggregate.totalCostUsd += call.costEstimateUsd;
    trafficByModel.set(model, aggregate);
  }

  const models = new Set([...taskByModel.keys(), ...trafficByModel.keys()]);
  return {
    window,
    generatedAt: now,
    models: [...models].map((model) => {
      const task = taskByModel.get(model) ?? emptyTaskAggregate();
      const traffic = trafficByModel.get(model) ?? emptyTrafficAggregate();
      return {
        model,
        providers: [...task.providers].sort(),
        task: {
          n: task.n,
          successRate: sampleRate(task.successes, task.n),
          averageDurationMs: average(task.durations),
          failureClasses: task.failureClasses,
        },
        traffic: {
          n: traffic.n,
          successRate: sampleRate(traffic.successes, traffic.n),
          p50LatencyMs: percentile(traffic.latencies, 0.5),
          p95LatencyMs: percentile(traffic.latencies, 0.95),
          errorClasses: traffic.errorClasses,
          totalCostUsd: traffic.totalCostUsd,
          costPerCallUsd: traffic.n === 0 ? null : traffic.totalCostUsd / traffic.n,
        },
      };
    }).sort(leaderboardSort),
  };
}

function readerWhere(window: OutcomeWindow, now: number, timestampColumn: "started_at" | "ts"): {
  clause: string;
  params: number[];
} {
  if (window === "all") return { clause: "", params: [] };
  return { clause: ` AND ${timestampColumn} >= ?`, params: [now - WINDOW_MS[window]] };
}

// Tenant-scoped, null-DB-safe reader. It performs SELECTs only and treats an
// unavailable or incompatible telemetry store as an empty leaderboard.
export function getOutcomeLeaderboard(
  window: OutcomeWindow = DEFAULT_OUTCOME_WINDOW,
  now = Date.now(),
): OutcomeLeaderboard {
  const db = getDashboardDb();
  if (!db) return emptyLeaderboard(now, window);

  try {
    const tenant = whereTenant();
    const taskWindow = readerWhere(window, now, "started_at");
    const trafficWindow = readerWhere(window, now, "ts");
    const builderPasses = db.query(`
      SELECT model, provider, status, started_at, finished_at, failure_class
      FROM builder_passes
      WHERE model IS NOT NULL AND TRIM(model) != '' ${tenant.clause}${taskWindow.clause}
    `).all(...tenant.params, ...taskWindow.params) as BuilderDbRow[];
    const gatewayCalls = db.query(`
      SELECT resolved_model, ts, latency_ms, cost_estimate_usd, success, error_class
      FROM gateway_calls
      WHERE resolved_model IS NOT NULL AND TRIM(resolved_model) != '' ${tenant.clause}${trafficWindow.clause}
    `).all(...tenant.params, ...trafficWindow.params) as GatewayDbRow[];

    return computeOutcomeLeaderboard({
      builderPasses: builderPasses.map((row) => ({
        model: row.model,
        provider: row.provider,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        failureClass: row.failure_class,
      })),
      gatewayCalls: gatewayCalls.map((row) => ({
        resolvedModel: row.resolved_model,
        ts: row.ts,
        latencyMs: row.latency_ms,
        costEstimateUsd: row.cost_estimate_usd,
        success: row.success,
        errorClass: row.error_class,
      })),
    }, now, window);
  } catch {
    return emptyLeaderboard(now, window);
  }
}
