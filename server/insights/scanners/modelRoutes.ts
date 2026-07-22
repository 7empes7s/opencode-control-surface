// Model-routing truth scanner (Catalog S7).
//
// The mapper and advisory helper below are deliberately pure. The reader only
// mines dashboard telemetry; it never reads, writes, reloads, or otherwise
// mutates the LiteLLM configuration.
import type { EvidenceRef } from "../../api/types.ts";
import { getDashboardDb } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";
import { writeActionAudit } from "../../db/writer.ts";
import { resolveStaleInsights, upsertInsight } from "../store.ts";
import type { Insight, InsightInput } from "../types.ts";

// Seven days is the active-route horizon required by Catalog S7.
export const ROUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Live failed health probes occur in five-call batches, so five retains that
// signal while avoiding a one-off request becoming a pruning recommendation.
export const DEAD_ROUTE_MIN_CALLS = 5;
export const PROBE_ONLY_CALLS = 5;
// These are the Catalog S7 defaults for distinguishing a former workhorse
// from a route that has never proved itself.
export const DEGRADED_ALL_TIME_MIN_CALLS = 50;
export const DEGRADED_ALL_TIME_MIN_SUCCESS_RATE = 0.6;
export const HEALTHY_BUILDER_MIN_PASSES = 10;
export const HEALTHY_BUILDER_MIN_SUCCESS_RATE = 0.6;
export const BROKEN_PAID_MAX_SUCCESS_RATE = 0.1;

type ScanResult = {
  scannedAt: number;
  findings: Insight[];
  resolvedCount: number;
};

export type ModelRouteStat = {
  routeName: string;
  allCalls: number;
  allSuccesses: number;
  recentCalls: number;
  recentSuccesses: number;
  recentDistinctDays: number;
  recentPaidCalls: number;
  dominantRecentErrorClass: string | null;
};

export type BuilderCapabilityStat = {
  provider: string;
  model: string;
  passes: number;
  successes: number;
};

export type ModelRouteStats = {
  routes: ModelRouteStat[];
  builderCapabilities: BuilderCapabilityStat[];
};

export type RouteAdvisories = {
  deadRoutes: string[];
  orphanProposals: Array<{ suggestion: string; rationale: string }>;
};

type GatewayStatsRow = {
  route_name: string;
  all_calls: number;
  all_successes: number;
  recent_calls: number;
  recent_successes: number;
  recent_distinct_days: number;
  recent_paid_calls: number;
};

type GatewayErrorRow = {
  route_name: string;
  error_class: string;
  calls: number;
};

type BuilderStatsRow = {
  provider: string | null;
  model: string;
  passes: number;
  successes: number;
};

function evidence(label: string, ref: string): EvidenceRef {
  return { label, kind: "db", ref, redacted: true };
}

function rate(successes: number, calls: number): number {
  return calls === 0 ? 0 : successes / calls;
}

function safeInsightId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 140) || "route";
}

function routeIsProbeOnly(route: ModelRouteStat): boolean {
  return route.allCalls === PROBE_ONLY_CALLS
    && route.recentCalls === PROBE_ONLY_CALLS
    && route.recentSuccesses === 0
    && route.recentDistinctDays === 1;
}

function routeIsDegraded(route: ModelRouteStat): boolean {
  return route.recentCalls >= DEAD_ROUTE_MIN_CALLS
    && route.recentSuccesses === 0
    && route.allCalls >= DEGRADED_ALL_TIME_MIN_CALLS
    && rate(route.allSuccesses, route.allCalls) >= DEGRADED_ALL_TIME_MIN_SUCCESS_RATE;
}

function routeIsDead(route: ModelRouteStat): boolean {
  return route.recentCalls >= DEAD_ROUTE_MIN_CALLS
    && route.recentSuccesses === 0
    && !routeIsDegraded(route);
}

function routeIsBrokenPaidFallback(route: ModelRouteStat): boolean {
  return route.recentCalls > 0
    && route.recentPaidCalls > 0
    && rate(route.recentSuccesses, route.recentCalls) < BROKEN_PAID_MAX_SUCCESS_RATE
    && route.dominantRecentErrorClass === "auth";
}

function capabilityKey(model: string): string {
  const concreteModel = model.trim().split("/").at(-1) ?? model;
  return concreteModel.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function routeCanServeCapability(routeName: string, model: string): boolean {
  const routeKey = routeName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const modelKey = capabilityKey(model);
  return modelKey.length > 0 && (routeKey.includes(modelKey) || modelKey.includes(routeKey));
}

function routeSuggestion(provider: string, model: string): { routeName: string; suggestion: string } {
  const concreteModel = model.trim().split("/").at(-1) ?? model.trim();
  const normalized = concreteModel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (model.startsWith("opencode-go/")) {
    const routeName = `coding-go-${normalized}`;
    return { routeName, suggestion: `${routeName} → hosted_vllm/${concreteModel}` };
  }
  const routeName = `${provider.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${normalized}`;
  return { routeName, suggestion: `${routeName} → ${model}` };
}

function orphanedCapabilities(stats: ModelRouteStats): Array<BuilderCapabilityStat & { routeName: string; suggestion: string }> {
  return stats.builderCapabilities
    .filter((capability) => capability.passes >= HEALTHY_BUILDER_MIN_PASSES)
    .filter((capability) => rate(capability.successes, capability.passes) >= HEALTHY_BUILDER_MIN_SUCCESS_RATE)
    .filter((capability) => !stats.routes.some((route) => route.allSuccesses > 0 && routeCanServeCapability(route.routeName, capability.model)))
    .map((capability) => ({ ...capability, ...routeSuggestion(capability.provider, capability.model) }))
    .sort((a, b) => a.routeName.localeCompare(b.routeName));
}

// Pure data-to-insight mapper. It accepts already-aggregated telemetry so unit
// tests need no dashboard DB and its output stays deterministic for a given now.
export function mapModelRouteFindings(stats: ModelRouteStats, now: number): InsightInput[] {
  const findings: InsightInput[] = [];
  const routes = [...stats.routes].sort((a, b) => a.routeName.localeCompare(b.routeName));

  for (const route of routes) {
    const allRate = rate(route.allSuccesses, route.allCalls);
    const recentRate = rate(route.recentSuccesses, route.recentCalls);
    const routeEvidence = [evidence("Gateway route telemetry", `gateway_calls:${route.routeName}`)];

    if (routeIsDead(route)) {
      findings.push({
        id: `insight_models_dead_route_${safeInsightId(route.routeName)}`,
        sourceKey: `models:dead-route:${route.routeName}`,
        domain: "models",
        severity: "high",
        title: `Fallback route ${route.routeName} is dead`,
        plainSummary: `${route.routeName} failed all ${route.recentCalls} gateway attempts in the last 7 days. Remove it from fallback chains in the copied preview; this scanner does not change LiteLLM configuration.`,
        confidence: 0.96,
        evidenceRefs: routeEvidence,
        actionDescriptorId: null,
        manualPageHref: "/models",
        createdAt: now,
      });
    }

    if (routeIsProbeOnly(route)) {
      findings.push({
        id: `insight_models_probe_only_route_${safeInsightId(route.routeName)}`,
        sourceKey: `models:probe-only-route:${route.routeName}`,
        domain: "models",
        severity: "medium",
        title: `Fallback route ${route.routeName} only failed its probe`,
        plainSummary: `${route.routeName} has exactly ${PROBE_ONLY_CALLS} attempts, all failed on one UTC day, and no success in the active 7-day window. It looks like a failed health-check probe rather than traffic.`,
        confidence: 0.91,
        evidenceRefs: routeEvidence,
        actionDescriptorId: null,
        manualPageHref: "/models",
        createdAt: now,
      });
    }

    if (routeIsDegraded(route)) {
      const error = route.dominantRecentErrorClass ?? "unknown";
      findings.push({
        id: `insight_models_degraded_route_${safeInsightId(route.routeName)}`,
        sourceKey: `models:degraded-route:${route.routeName}`,
        domain: "models",
        severity: "high",
        title: `Fallback route ${route.routeName} has regressed`,
        plainSummary: `${route.routeName} was healthy all-time (${route.allSuccesses}/${route.allCalls}, ${Math.round(allRate * 100)}%) but failed all ${route.recentCalls} attempts in the last 7 days. Dominant recent error: ${error}; investigate before deleting a formerly working route.`,
        confidence: 0.94,
        evidenceRefs: routeEvidence,
        actionDescriptorId: null,
        manualPageHref: "/models",
        createdAt: now,
      });
    }

    if (routeIsBrokenPaidFallback(route)) {
      findings.push({
        id: `insight_models_broken_paid_fallback_${safeInsightId(route.routeName)}`,
        sourceKey: `models:broken-paid-fallback:${route.routeName}`,
        domain: "models",
        severity: "high",
        title: `Paid fallback ${route.routeName} is auth-broken`,
        plainSummary: `${route.routeName} incurred paid gateway attempts but only ${Math.round(recentRate * 100)}% succeeded in the last 7 days; auth is the dominant failure. A paid last-resort route that cannot authenticate leaves the chain with no recovery.`,
        confidence: 0.95,
        evidenceRefs: routeEvidence,
        actionDescriptorId: null,
        manualPageHref: "/models",
        createdAt: now,
      });
    }
  }

  for (const capability of orphanedCapabilities(stats)) {
    findings.push({
      id: `insight_models_orphaned_capability_${safeInsightId(capability.routeName)}`,
      sourceKey: `models:orphaned-capability:${capability.routeName}`,
      domain: "models",
      severity: "medium",
      title: `Working builder capability ${capability.model} has no gateway route`,
      plainSummary: `${capability.provider}/${capability.model} succeeded ${capability.successes}/${capability.passes} builder passes, but no matching gateway route has recorded a success. Suggested config line: ${capability.suggestion}.`,
      confidence: 0.9,
      evidenceRefs: [
        evidence("Builder capability telemetry", `builder_passes:${capability.provider}/${capability.model}`),
        evidence("Gateway route telemetry", `gateway_calls:${capability.routeName}`),
      ],
      actionDescriptorId: null,
      manualPageHref: "/models",
      createdAt: now,
    });
  }

  return findings;
}

// Pure chain-preview inputs derived from the same facts as the scanner. The
// returned suggestions are advisory only; no capability is auto-woven into a
// fallback chain.
export function deriveRouteAdvisories(stats: ModelRouteStats): RouteAdvisories {
  return {
    deadRoutes: stats.routes.filter(routeIsDead).map((route) => route.routeName).sort(),
    orphanProposals: orphanedCapabilities(stats).map((capability) => ({
      suggestion: capability.suggestion,
      rationale: `${capability.provider}/${capability.model} succeeded ${capability.successes}/${capability.passes} builder passes, while no matching gateway route has recorded a success.`,
    })),
  };
}

// Dashboard reader. Each query is tenant-scoped, and a disabled/unavailable
// dashboard DB is intentionally an empty, safe scan.
export function getRouteStats(now = Date.now()): ModelRouteStats {
  const db = getDashboardDb();
  if (!db) return { routes: [], builderCapabilities: [] };

  const since = now - ROUTE_WINDOW_MS;
  const tenant = whereTenant();
  const routeRows = db.query(`
    SELECT resolved_model AS route_name,
      COUNT(*) AS all_calls,
      COALESCE(SUM(success), 0) AS all_successes,
      SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS recent_calls,
      COALESCE(SUM(CASE WHEN ts >= ? THEN success ELSE 0 END), 0) AS recent_successes,
      COUNT(DISTINCT CASE WHEN ts >= ? THEN date(ts / 1000, 'unixepoch') END) AS recent_distinct_days,
      COALESCE(SUM(CASE WHEN ts >= ? AND COALESCE(cost_estimate_usd, 0) > 0 THEN 1 ELSE 0 END), 0) AS recent_paid_calls
    FROM gateway_calls
    WHERE resolved_model IS NOT NULL AND TRIM(resolved_model) != '' ${tenant.clause}
    GROUP BY resolved_model
  `).all(since, since, since, since, ...tenant.params) as GatewayStatsRow[];

  const errorRows = db.query(`
    SELECT resolved_model AS route_name,
      COALESCE(NULLIF(error_class, ''), 'unknown') AS error_class,
      COUNT(*) AS calls
    FROM gateway_calls
    WHERE ts >= ? AND success = 0 ${tenant.clause}
    GROUP BY resolved_model, COALESCE(NULLIF(error_class, ''), 'unknown')
  `).all(since, ...tenant.params) as GatewayErrorRow[];

  const dominantErrors = new Map<string, { errorClass: string; calls: number }>();
  for (const row of errorRows) {
    const current = dominantErrors.get(row.route_name);
    if (!current || row.calls > current.calls || (row.calls === current.calls && row.error_class < current.errorClass)) {
      dominantErrors.set(row.route_name, { errorClass: row.error_class, calls: row.calls });
    }
  }

  const builderRows = db.query(`
    SELECT provider, model,
      COUNT(*) AS passes,
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successes
    FROM builder_passes
    WHERE model IS NOT NULL AND TRIM(model) != '' ${tenant.clause}
    GROUP BY provider, model
  `).all(...tenant.params) as BuilderStatsRow[];

  return {
    routes: routeRows.map((row) => ({
      routeName: row.route_name,
      allCalls: Number(row.all_calls),
      allSuccesses: Number(row.all_successes),
      recentCalls: Number(row.recent_calls),
      recentSuccesses: Number(row.recent_successes),
      recentDistinctDays: Number(row.recent_distinct_days),
      recentPaidCalls: Number(row.recent_paid_calls),
      dominantRecentErrorClass: dominantErrors.get(row.route_name)?.errorClass ?? null,
    })),
    builderCapabilities: builderRows.map((row) => ({
      provider: row.provider?.trim() || "unknown",
      model: row.model,
      passes: Number(row.passes),
      successes: Number(row.successes),
    })),
  };
}

export function runModelRoutesScan(): ScanResult {
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  if (!getDashboardDb()) return { scannedAt, findings, resolvedCount: 0 };

  const descriptors = mapModelRouteFindings(getRouteStats(scannedAt), scannedAt);
  const emittedSourceKeys: string[] = [];
  for (const descriptor of descriptors) {
    const finding = upsertInsight(descriptor);
    if (finding) {
      findings.push(finding);
      if (descriptor.sourceKey) emittedSourceKeys.push(descriptor.sourceKey);
    }
  }

  const resolved = resolveStaleInsights(
    "models:",
    emittedSourceKeys,
    "The model-route scanner confirmed this routing condition is no longer present in current telemetry.",
  );
  for (const insight of resolved) {
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-resolve",
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      resultStatus: "success",
      result: "The model-route scanner confirmed this condition has cleared.",
      request: { sourceKey: insight.sourceKey ?? insight.id },
    });
  }

  return { scannedAt, findings, resolvedCount: resolved.length };
}
