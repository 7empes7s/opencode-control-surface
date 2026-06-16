import { ok } from "./types.ts";
import { checkToken } from "./actions.ts";
import {
  gatewayComplete,
  gatewayModels,
  getGatewayRouteOverrideForGatewayAdmin,
  getCircuitStates,
  setGatewayRouteOverrideForGatewayAdmin,
  setCircuitStateForGatewayAdmin,
} from "../gateway/router.ts";
import { ledgerStats, readLedger } from "../gateway/ledger.ts";
import { loadGatewayConfig, type ModelTier } from "../gateway/config.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { getModelsDetail } from "../adapters/models.ts";
import {
  checkKeyDailySpend,
  verifyGatewayKey,
} from "../gateway/keys.ts";

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiError(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")) return {};
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function reasonFromBody(body: Record<string, unknown>): string | undefined {
  const reason = body.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
}

function auditGateway(input: Parameters<typeof writeActionAudit>[0]): void {
  const ctx = getCurrentTenantContext();
  writeActionAudit({
    actor: ctx.actor ?? "operator",
    actorSource: ctx.source,
    targetType: "gateway",
    risk: "medium",
    ...input,
  });
}

type GatewayRecommendation = {
  kind: "open_circuit" | "high_error_rate" | "high_latency";
  severity: "warn" | "critical";
  title: string;
  message: string;
  targetId?: string;
  recommendedAction: "half-open-circuit" | "reset-circuit" | "run-probe" | "route-healthiest";
};

function gatewayHealthSummary() {
  const now = Date.now();
  const since = now - 24 * 60 * 60 * 1000;
  const circuits = getCircuitStates();
  const stats = ledgerStats(since);
  const recentRows = readLedger({ limit: 500 }).filter((row) => row.ts >= since);
  const openCircuits = Object.entries(circuits)
    .filter(([, circuit]) => circuit.state === "open")
    .map(([model, circuit]) => ({ model, ...circuit }));

  const HIGH_ERROR_RATE = 0.15;
  const HIGH_LATENCY_MS = 10_000;
  const errorRate = stats.totalCalls > 0 ? 1 - stats.successRate : 0;

  const latencyByModel = new Map<string, { total: number; count: number }>();
  for (const row of recentRows) {
    if (row.latency_ms == null) continue;
    const current = latencyByModel.get(row.logical_model) ?? { total: 0, count: 0 };
    current.total += row.latency_ms;
    current.count += 1;
    latencyByModel.set(row.logical_model, current);
  }

  const highLatencyModels = Array.from(latencyByModel.entries())
    .map(([model, value]) => ({ model, avgLatencyMs: value.count > 0 ? value.total / value.count : 0, calls: value.count }))
    .filter((row) => row.calls >= 2 && row.avgLatencyMs >= HIGH_LATENCY_MS)
    .sort((a, b) => b.avgLatencyMs - a.avgLatencyMs);

  const recommendations: GatewayRecommendation[] = [];
  if (openCircuits.length > 0) {
    const first = openCircuits[0];
    recommendations.push({
      kind: "open_circuit",
      severity: "critical",
      title: `${openCircuits.length} open gateway circuit${openCircuits.length === 1 ? "" : "s"}`,
      message: `${first.model} is open. Half-open it for a controlled probe or route traffic to the healthiest free/cloud model.`,
      targetId: first.model,
      recommendedAction: "half-open-circuit",
    });
  }

  if (stats.totalCalls >= 3 && errorRate >= HIGH_ERROR_RATE) {
    recommendations.push({
      kind: "high_error_rate",
      severity: "warn",
      title: `Gateway error rate is ${(errorRate * 100).toFixed(1)}%`,
      message: "Recent gateway calls are failing above the operator threshold. Run a probe or route to the healthiest free/cloud model.",
      recommendedAction: "run-probe",
    });
  }

  if (highLatencyModels.length > 0) {
    const first = highLatencyModels[0];
    recommendations.push({
      kind: "high_latency",
      severity: "warn",
      title: `High latency on ${first.model}`,
      message: `Average latency is ${Math.round(first.avgLatencyMs)}ms over recent calls. Prefer a healthier free/cloud route.`,
      targetId: first.model,
      recommendedAction: "route-healthiest",
    });
  }

  return {
    lastUpdatedAt: new Date(now).toISOString(),
    degraded: recommendations.length > 0,
    recommendations,
    summary: {
      openCircuits,
      highErrorRate: {
        triggered: stats.totalCalls >= 3 && errorRate >= HIGH_ERROR_RATE,
        errorRate,
        threshold: HIGH_ERROR_RATE,
        totalCalls: stats.totalCalls,
      },
      highLatency: {
        triggered: highLatencyModels.length > 0,
        thresholdMs: HIGH_LATENCY_MS,
        models: highLatencyModels,
      },
    },
  };
}

function costHeadlineStats() {
  const db = getDashboardDb();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  let totalCalls = 0;
  let freeShareCalls = 0;
  let estimatedSpendUsd = 0;

  if (db) {
    try {
      const ctx = getCurrentTenantContext();
      const tenantWhere = ctx.tenantId === "mimule"
        ? "(tenant_id = ? OR tenant_id IS NULL)"
        : "tenant_id = ?";

      const stats = db.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN cost_estimate_usd IS NULL OR cost_estimate_usd = 0 THEN 1 ELSE 0 END) as free,
          SUM(COALESCE(cost_estimate_usd, 0)) as spend
        FROM gateway_calls
        WHERE ts >= ? AND ${tenantWhere}
      `).get(thirtyDaysAgo, ctx.tenantId) as { total: number; free: number; spend: number } | null;

      if (stats) {
        totalCalls = Number(stats.total || 0);
        freeShareCalls = Number(stats.free || 0);
        estimatedSpendUsd = Number(stats.spend || 0);
      }
    } catch (e) {
      console.error("[gateway] cost headline stats query failed:", e);
    }
  }

  const freeSharePct = totalCalls > 0 ? Math.round((freeShareCalls / totalCalls) * 100) : 0;

  let freeModelsAvailable = 0;
  let modelsDiscovered = 0;
  try {
    const detail = getModelsDetail();
    modelsDiscovered = detail.models.length;
    freeModelsAvailable = detail.models.filter(m => m.isFree && m.available).length;
  } catch {
    // Graceful degradation
  }

  const headline = totalCalls > 0
    ? `${freeSharePct}% of the last ${totalCalls} model calls were routed to free models — estimated spend $${estimatedSpendUsd.toFixed(2)} in the last 30 days, with ${freeModelsAvailable} free models on standby.`
    : "Cost tracking is warming up — no gateway calls recorded in the last 30 days.";

  return {
    totalCalls,
    freeShareCalls,
    freeSharePct,
    estimatedSpendUsd: Number(estimatedSpendUsd.toFixed(2)),
    freeModelsAvailable,
    modelsDiscovered,
    headline,
  };
}

// GET /api/gateway/showback — spend by model/caller + counterfactual pricing
export function gatewayShowbackHandler(req: Request): Response {
  if (!checkToken(req)) {
    return json({ error: "unauthorized" }, 401);
  }
  const db = getDashboardDb();
  const ctx = getCurrentTenantContext();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const tenantWhere = ctx.tenantId === "mimule"
    ? "(tenant_id = ? OR tenant_id IS NULL)"
    : "tenant_id = ?";

  const byModel: Array<{ model: string; calls: number; costUsd: number }> = [];
  const byCaller: Array<{ caller: string; calls: number; costUsd: number }> = [];
  const byBasis: Array<{ basis: string; events: number; costUsd: number }> = [];
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEvents = 0;

  if (db) {
    try {
      const modelRows = db.query(`
        SELECT logical_model as model,
               COUNT(*) as calls,
               SUM(COALESCE(cost_estimate_usd, 0)) as cost
        FROM gateway_calls
        WHERE ts >= ? AND ${tenantWhere}
        GROUP BY logical_model
        ORDER BY calls DESC
      `).all(thirtyDaysAgo, ctx.tenantId) as Array<{ model: string; calls: number; cost: number }>;
      for (const row of modelRows) {
        byModel.push({
          model: row.model,
          calls: Number(row.calls ?? 0),
          costUsd: Number(Number(row.cost ?? 0).toFixed(2)),
        });
        totalCostUsd += Number(row.cost ?? 0);
      }

      const callerRows = db.query(`
        SELECT COALESCE(caller, 'unattributed') as caller,
               COUNT(*) as calls,
               SUM(COALESCE(cost_estimate_usd, 0)) as cost
        FROM gateway_calls
        WHERE ts >= ? AND ${tenantWhere}
        GROUP BY caller
        ORDER BY calls DESC
      `).all(thirtyDaysAgo, ctx.tenantId) as Array<{ caller: string; calls: number; cost: number }>;
      for (const row of callerRows) {
        byCaller.push({
          caller: row.caller,
          calls: Number(row.calls ?? 0),
          costUsd: Number(Number(row.cost ?? 0).toFixed(2)),
        });
      }

      const basisRows = db.query(`
        SELECT cost_basis as basis,
               COUNT(*) as events,
               SUM(COALESCE(cost_cents, 0)) / 100.0 as cost
        FROM cost_events
        WHERE ts >= ? AND ${tenantWhere}
        GROUP BY cost_basis
        ORDER BY events DESC
      `).all(thirtyDaysAgo, ctx.tenantId) as Array<{ basis: string; events: number; cost: number }>;
      for (const row of basisRows) {
        byBasis.push({
          basis: row.basis,
          events: Number(row.events ?? 0),
          costUsd: Number(Number(row.cost ?? 0).toFixed(2)),
        });
        totalEvents += Number(row.events ?? 0);
      }

      const tokenRow = db.query(`
        SELECT
          SUM(COALESCE(input_tokens, 0)) as inp,
          SUM(COALESCE(output_tokens, 0)) as outp
        FROM cost_events
        WHERE ts >= ? AND ${tenantWhere}
      `).get(thirtyDaysAgo, ctx.tenantId) as { inp: number; outp: number } | null;
      if (tokenRow) {
        totalInputTokens = Number(tokenRow.inp ?? 0);
        totalOutputTokens = Number(tokenRow.outp ?? 0);
      }
    } catch (e) {
      console.error("[gateway] showback query failed:", e);
    }
  }

  const cfg = loadGatewayConfig();
  const costEntries = Object.entries(cfg.costEstimates);
  let counterfactualTier: ModelTier = "cloud-paid";
  let counterfactualRate: { prompt: number; completion: number } = { prompt: 0, completion: 0 };
  for (const [tier, estimate] of costEntries) {
    const sum = (estimate?.prompt ?? 0) + (estimate?.completion ?? 0);
    const current = counterfactualRate.prompt + counterfactualRate.completion;
    if (sum > current) {
      counterfactualTier = tier as ModelTier;
      counterfactualRate = estimate;
    }
  }

  const availableTokens = (totalInputTokens + totalOutputTokens) > 0;
  let estimatedPaidUsd: number | null = null;
  let explanation: string;
  if (availableTokens) {
    const perToken = (counterfactualRate.prompt + counterfactualRate.completion) / 1_000_000;
    estimatedPaidUsd = Number((perToken * (totalInputTokens + totalOutputTokens)).toFixed(2));
    explanation = `Based on recorded token volumes priced at the ${counterfactualTier} tier estimate.`;
  } else {
    explanation = "Not enough token data recorded yet to estimate what paid-first routing would have cost.";
  }

  return json(ok({
    window: "30d",
    byModel,
    byCaller,
    byBasis,
    totalCostUsd: Number(totalCostUsd.toFixed(2)),
    totalEvents,
    counterfactual: {
      availableTokens,
      estimatedPaidUsd,
      tier: counterfactualTier,
      explanation,
    },
    lastUpdatedAt: new Date(now).toISOString(),
  }));
}

// GET /api/gateway/status — circuit states + config summary
export function gatewayStatusHandler(): Response {
  const cfg = loadGatewayConfig();
  const circuits = getCircuitStates();
  const health = gatewayHealthSummary();
  const costHeadline = costHeadlineStats();
  return json(ok({
    version: cfg.version,
    litellmUrl: cfg.litellmUrl,
    modelCount: Object.keys(cfg.models).length,
    circuits,
    routeOverride: getGatewayRouteOverrideForGatewayAdmin(),
    costHeadline,
    ...health,
  }));
}

// GET /api/gateway/models — list all known models
export async function gatewayModelsHandler(): Promise<Response> {
  try {
    const list = await gatewayModels();
    return json(ok({ models: list }));
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 502);
  }
}

// GET /api/gateway/ledger?limit=N&model=X
export function gatewayLedgerHandler(url: URL): Response {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 500);
  const logicalModel = url.searchParams.get("model") ?? undefined;
  const onlyFailed = url.searchParams.get("failed") === "1";
  const rows = readLedger({ limit, logicalModel, onlyFailed });
  return json(ok({ rows, lastUpdatedAt: new Date().toISOString() }));
}

// GET /api/gateway/stats?since=<ms>
export function gatewayStatsHandler(url: URL): Response {
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? Number(sinceRaw) : Date.now() - 24 * 60 * 60 * 1000;
  const stats = ledgerStats(since);
  return json(ok({ ...stats, lastUpdatedAt: new Date().toISOString() }));
}

export async function gatewayCircuitActionHandler(req: Request, model: string, action: "reset" | "half-open"): Promise<Response> {
  const body = await readJsonBody(req);
  const decodedModel = decodeURIComponent(model);
  const actionKind = action === "reset" ? "gateway.circuit.reset" : "gateway.circuit.half-open";
  const actionId = `${actionKind}:${decodedModel}`;

  try {
    const circuit = setCircuitStateForGatewayAdmin(decodedModel, action === "reset" ? "closed" : "half-open");
    auditGateway({
      actionKind,
      actionId,
      targetId: decodedModel,
      reason: reasonFromBody(body),
      request: { model: decodedModel, action },
      resultStatus: "success",
      result: `${decodedModel} circuit ${action}`,
      resultJson: { circuit, timestamp: new Date().toISOString() },
      rollbackHint: action === "reset"
        ? "Run a gateway probe before sending production traffic if the upstream is uncertain."
        : "Reset the circuit back to closed if the half-open probe succeeds.",
    });
    return json(ok({ ok: true, model: decodedModel, action, circuit, lastUpdatedAt: new Date().toISOString() }));
  } catch (error) {
    auditGateway({
      actionKind,
      actionId,
      targetId: decodedModel,
      reason: reasonFromBody(body),
      request: { model: decodedModel, action },
      resultStatus: "failed",
      error: errorMessage(error),
    });
    return apiError(errorMessage(error), 500);
  }
}

function modelStatsFromLedger() {
  const rows = readLedger({ limit: 500 });
  const byModel = new Map<string, { calls: number; errors: number; totalLatencyMs: number; latencyCount: number }>();
  for (const row of rows) {
    for (const model of [row.logical_model, row.resolved_model].filter(Boolean)) {
      const current = byModel.get(model) ?? { calls: 0, errors: 0, totalLatencyMs: 0, latencyCount: 0 };
      current.calls += 1;
      if (!row.success) current.errors += 1;
      if (row.latency_ms != null) {
        current.totalLatencyMs += row.latency_ms;
        current.latencyCount += 1;
      }
      byModel.set(model, current);
    }
  }
  return byModel;
}

function freeSignal(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes(":free") || lower.includes("-free") || lower.includes("/free") || lower.endsWith("free");
}

function cloudSignal(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("openrouter")
    || lower.includes("opencode/")
    || lower.includes("gemini")
    || lower.includes("nvidia/")
    || lower.includes("groq/")
    || lower.includes("cerebras/");
}

export function selectHealthiestGatewayModel() {
  const cfg = loadGatewayConfig();
  const circuits = getCircuitStates();
  const stats = modelStatsFromLedger();
  const preferred = [
    "opencode/nemotron-3-ultra-free",
    "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
    "gemini-2.5-flash",
  ];

  const configured = Object.entries(cfg.models).map(([logicalName, entry]) => ({
    logicalName,
    resolvedModel: entry.model,
    tier: entry.tier,
  }));

  const fallback: Array<{ logicalName: string; resolvedModel: string; tier: ModelTier }> = preferred.map((model) => ({
    logicalName: model,
    resolvedModel: model,
    tier: freeSignal(model) ? "cloud-free" : "cloud-paid",
  }));

  const seen = new Set<string>();
  const candidates = [...configured, ...fallback].filter((candidate) => {
    const key = `${candidate.logicalName}:${candidate.resolvedModel}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((candidate) => {
    const circuit = circuits[candidate.logicalName] ?? circuits[candidate.resolvedModel];
    const stat = stats.get(candidate.logicalName) ?? stats.get(candidate.resolvedModel);
    const calls = stat?.calls ?? 0;
    const errors = stat?.errors ?? 0;
    const errorRate = calls > 0 ? errors / calls : 0;
    const avgLatencyMs = stat && stat.latencyCount > 0 ? stat.totalLatencyMs / stat.latencyCount : 0;
    const isFree = candidate.tier === "cloud-free" || freeSignal(candidate.logicalName) || freeSignal(candidate.resolvedModel);
    const isCloud = candidate.tier.startsWith("cloud") || cloudSignal(candidate.logicalName) || cloudSignal(candidate.resolvedModel);
    const preferenceIndex = preferred.findIndex((item) => item === candidate.logicalName || item === candidate.resolvedModel);
    return {
      ...candidate,
      circuitState: circuit?.state ?? "closed",
      healthy: circuit?.state !== "open" && (calls < 3 || errorRate < 0.2),
      isFree,
      isCloud,
      calls,
      errorRate,
      avgLatencyMs,
      preferenceRank: preferenceIndex === -1 ? 99 : preferenceIndex,
    };
  });

  candidates.sort((a, b) =>
    Number(b.healthy) - Number(a.healthy)
    || Number(b.isFree) - Number(a.isFree)
    || Number(b.isCloud) - Number(a.isCloud)
    || a.preferenceRank - b.preferenceRank
    || a.errorRate - b.errorRate
    || a.avgLatencyMs - b.avgLatencyMs
    || a.logicalName.localeCompare(b.logicalName)
  );

  return candidates[0] ?? null;
}

export async function gatewayRouteHealthiestHandler(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const selected = selectHealthiestGatewayModel();
  const actionKind = "gateway.route-healthiest";
  if (!selected) {
    auditGateway({
      actionKind,
      actionId: actionKind,
      targetId: "none",
      reason: reasonFromBody(body),
      request: body,
      resultStatus: "failed",
      error: "no gateway models available",
    });
    return apiError("no gateway models available", 404);
  }

  const ctx = getCurrentTenantContext();
  const ttlMs = typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs) ? body.ttlMs : undefined;
  const routeOverride = setGatewayRouteOverrideForGatewayAdmin({
    targetModel: selected.logicalName,
    resolvedModel: selected.resolvedModel,
    tier: selected.tier,
    reason: reasonFromBody(body),
    setBy: ctx.actor ?? "operator",
    ttlMs,
  });

  auditGateway({
    actionKind,
    actionId: `${actionKind}:${selected.logicalName}`,
    targetId: selected.logicalName,
    reason: reasonFromBody(body),
    request: body,
    resultStatus: "success",
    result: `routed gateway traffic to ${selected.logicalName}`,
    resultJson: { selected, routeOverride, timestamp: new Date().toISOString() },
    rollbackHint: `The route override expires at ${routeOverride.expiresAt}. Run route healthiest again to replace it.`,
  });

  return json(ok({
    ok: true,
    selected,
    routeOverride,
    message: `Routing gateway traffic to ${selected.logicalName} until ${routeOverride.expiresAt}.`,
    lastUpdatedAt: new Date().toISOString(),
  }));
}

export async function gatewayProbeHandler(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const requestedModel = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : selectHealthiestGatewayModel()?.logicalName;
  const actionKind = "gateway.probe";

  if (!requestedModel) {
    auditGateway({
      actionKind,
      actionId: actionKind,
      targetId: "none",
      reason: reasonFromBody(body),
      request: body,
      resultStatus: "failed",
      error: "model required",
    });
    return apiError("model required", 400);
  }

  const startedAt = Date.now();
  try {
    const cfg = loadGatewayConfig();
    const timeoutMs = Number.isFinite(cfg.circuitBreaker.probeTimeoutMs) ? cfg.circuitBreaker.probeTimeoutMs : 8_000;
    const result = await gatewayComplete(requestedModel, {
      model: requestedModel,
      messages: [{ role: "user", content: "Reply with ok." }],
      temperature: 0,
      max_tokens: 8,
    }, { caller: "gateway-admin-probe", timeoutMs });
    const probe = {
      ok: true,
      model: requestedModel,
      latencyMs: Date.now() - startedAt,
      usage: result.usage ?? null,
    };
    auditGateway({
      actionKind,
      actionId: `${actionKind}:${requestedModel}`,
      targetId: requestedModel,
      reason: reasonFromBody(body),
      request: { ...body, model: requestedModel },
      resultStatus: "success",
      result: `${requestedModel} probe succeeded`,
      resultJson: probe,
    });
    return json(ok({ ...probe, lastUpdatedAt: new Date().toISOString() }));
  } catch (error) {
    const probe = {
      ok: false,
      model: requestedModel,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
    auditGateway({
      actionKind,
      actionId: `${actionKind}:${requestedModel}`,
      targetId: requestedModel,
      reason: reasonFromBody(body),
      request: { ...body, model: requestedModel },
      resultStatus: "failed",
      resultJson: probe,
      error: probe.error,
    });
    return json(ok({ ...probe, lastUpdatedAt: new Date().toISOString() }), 502);
  }
}

// POST /v1/chat/completions — OpenAI-compatible surface
export async function v1ChatCompletionsHandler(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return apiError("invalid JSON body", 400);
  }

  const model = String(body.model ?? "editorial-heavy");
  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return apiError("messages required", 400);
  }
  const messages = rawMessages as import("../gateway/adapters/base.ts").CompletionMessage[];
  for (const m of messages) {
    if (!m || typeof m !== "object" || typeof (m as { role?: unknown }).role !== "string") {
      return apiError("each message must be an object with a string 'role'", 400);
    }
  }

  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/);
  let caller = "v1-surface";

  if (bearerMatch) {
    const plaintext = bearerMatch[1];
    if (!plaintext.startsWith("gwk_")) {
      return json({ error: "This gateway requires an agent key. Create one on /gateway." }, 401);
    }
    const verified = verifyGatewayKey(plaintext);
    if (!verified) {
      return json({ error: "Agent key is invalid or revoked. Create a new key on /gateway." }, 401);
    }
    if (verified.modelAllowlist.length > 0 && !verified.modelAllowlist.includes(model)) {
      auditGateway({
        actor: verified.agentId,
        actorSource: "gateway-key",
        actionKind: "gateway.model-denied",
        actionId: `gateway.model-denied:${verified.agentId}:${model}`,
        targetType: "gateway",
        targetId: model,
        risk: "low",
        resultStatus: "blocked",
        request: { model, allowed: verified.modelAllowlist },
        result: `model ${model} not in key allowlist`,
      });
      return json({
        error: `Model "${model}" is not in this key's allowlist. Allowed models: ${verified.modelAllowlist.join(", ")}.`,
        code: "model_not_allowed",
        allowedModels: verified.modelAllowlist,
      }, 403);
    }
    if (verified.dailyCapUsd != null) {
      const spend = checkKeyDailySpend(verified.agentId, verified.dailyCapUsd);
      if (!spend.allowed) {
        auditGateway({
          actor: verified.agentId,
          actorSource: "gateway-key",
          actionKind: "gateway.key-budget-stop",
          actionId: `gateway.key-budget-stop:${verified.agentId}:${model}`,
          targetType: "gateway",
          targetId: verified.keyId,
          risk: "low",
          resultStatus: "blocked",
          request: { model, dailyCapUsd: verified.dailyCapUsd, spentUsd: spend.spentUsd },
          result: `daily cap ${verified.dailyCapUsd} reached (spent ${spend.spentUsd.toFixed(4)})`,
        });
        return json({
          error: `Daily cap of $${verified.dailyCapUsd.toFixed(2)} reached for this key. Resets at 00:00 UTC.`,
          code: "daily_cap_exceeded",
          dailyCapUsd: verified.dailyCapUsd,
          spentUsd: Number(spend.spentUsd.toFixed(4)),
        }, 429);
      }
    }
    caller = verified.agentId;
  } else if (checkToken(req)) {
    caller = "operator";
  } else {
    return json({ error: "This gateway requires an agent key. Create one on /gateway." }, 401);
  }

  try {
    const result = await gatewayComplete(model, {
      model,
      messages,
      temperature: body.temperature as number | undefined,
      max_tokens: body.max_tokens as number | undefined,
      tools: body.tools,
      tool_choice: body.tool_choice,
      response_format: body.response_format,
      stop: body.stop,
      top_p: body.top_p as number | undefined,
      frequency_penalty: body.frequency_penalty as number | undefined,
      presence_penalty: body.presence_penalty as number | undefined,
      seed: body.seed as number | undefined,
      user: typeof body.user === "string" ? body.user : undefined,
    }, { caller });

    if (body.stream === true) {
      return sseChatCompletionResponse(result);
    }
    return json(result);
  } catch (e) {
    return json({ error: { message: e instanceof Error ? e.message : String(e), type: "gateway_error" } }, 502);
  }
}

function sseChatCompletionResponse(result: import("../gateway/adapters/base.ts").CompletionResponse): Response {
  const enc = new TextEncoder();
  const firstChoice = result.choices[0];
  const rawMessage = firstChoice?.message ?? { role: "assistant", content: "" };
  const message = rawMessage as {
    role?: string;
    content?: string | null;
    tool_calls?: unknown;
    [key: string]: unknown;
  };
  const toolCallsIn = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [];
  const contentText = typeof message.content === "string" ? message.content : "";
  const finishReason = firstChoice?.finish_reason ?? "stop";
  const id = result.id;
  const created = result.created;
  const model = result.model;

  const firstDelta: Record<string, unknown> = { role: "assistant" };
  if (contentText.length > 0) firstDelta.content = contentText;
  if (toolCallsIn.length > 0) {
    firstDelta.tool_calls = toolCallsIn.map((tc, i) => {
      const fn = (tc.function ?? {}) as { name?: string; arguments?: string };
      return {
        index: i,
        ...(typeof tc.id === "string" ? { id: tc.id } : {}),
        ...(typeof tc.type === "string" ? { type: tc.type } : {}),
        function: {
          ...(typeof fn.name === "string" ? { name: fn.name } : {}),
          ...(typeof fn.arguments === "string" ? { arguments: fn.arguments } : {}),
        },
      };
    });
  }

  const firstChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: firstDelta, finish_reason: null }],
  };
  const finalChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  const doneChunk = { id, object: "chat.completion.chunk", created, model, choices: [] };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// GET /v1/models — OpenAI-compatible models listing
export async function v1ModelsHandler(): Promise<Response> {
  const list = await gatewayModels().catch(() => []);
  return json({ object: "list", data: list });
}
