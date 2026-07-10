import { loadGatewayConfig, resolveModel, type ModelEntry, type ModelTier } from "./config.ts";
import { LiteLLMAdapter } from "./adapters/litellm.ts";
import { writeLedgerEntry } from "./ledger.ts";
import type { CompletionRequest, CompletionResponse, ModelInfo } from "./adapters/base.ts";
import { checkBudget } from "../governance/budgets.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";

// ── Circuit breaker state (in-process, reset on restart) ──────────────────────

type CircuitState = "closed" | "open" | "half-open";

type CircuitEntry = {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
};

const circuits = new Map<string, CircuitEntry>();

type GatewayRouteOverride = {
  targetModel: string;
  resolvedModel: string;
  tier: ModelTier;
  reason?: string;
  setAt: string;
  setBy: string;
  expiresAt: string;
};

let routeOverride: GatewayRouteOverride | null = null;
let routeOverrideLoaded = false;

type GatewayRouteOverrideRow = {
  target_model: string;
  resolved_model: string;
  tier: ModelTier;
  reason: string | null;
  set_at: string;
  set_by: string;
  expires_at: string;
};

function ensureRouteOverrideLoaded(): void {
  if (routeOverrideLoaded) return;
  routeOverrideLoaded = true;
  if (!isDashboardDbEnabled()) return;

  try {
    const db = getDashboardDb();
    if (!db) return;
    const row = db.query(`
      SELECT target_model, resolved_model, tier, reason, set_at, set_by, expires_at
      FROM gateway_route_override
      WHERE id = 1
    `).get() as GatewayRouteOverrideRow | null;
    if (!row) return;
    routeOverride = {
      targetModel: row.target_model,
      resolvedModel: row.resolved_model,
      tier: row.tier,
      reason: row.reason ?? undefined,
      setAt: row.set_at,
      setBy: row.set_by,
      expiresAt: row.expires_at,
    };
  } catch (error) {
    console.warn("[gateway] route override load failed", error);
  }
}

function persistRouteOverride(override: GatewayRouteOverride): void {
  if (!isDashboardDbEnabled()) return;

  try {
    const db = getDashboardDb();
    if (!db) return;
    db.query(`
      INSERT INTO gateway_route_override
        (id, target_model, resolved_model, tier, reason, set_at, set_by, expires_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target_model = excluded.target_model,
        resolved_model = excluded.resolved_model,
        tier = excluded.tier,
        reason = excluded.reason,
        set_at = excluded.set_at,
        set_by = excluded.set_by,
        expires_at = excluded.expires_at
    `).run(
      override.targetModel,
      override.resolvedModel,
      override.tier,
      override.reason ?? null,
      override.setAt,
      override.setBy,
      override.expiresAt,
    );
  } catch (error) {
    console.warn("[gateway] route override save failed", error);
  }
}

function deletePersistedRouteOverride(): void {
  if (!isDashboardDbEnabled()) return;

  try {
    const db = getDashboardDb();
    if (!db) return;
    db.query("DELETE FROM gateway_route_override WHERE id = 1").run();
  } catch (error) {
    console.warn("[gateway] route override delete failed", error);
  }
}

function getCircuit(model: string): CircuitEntry {
  if (!circuits.has(model)) circuits.set(model, { state: "closed", failures: 0, openedAt: null });
  return circuits.get(model)!;
}

function recordSuccess(model: string): void {
  const c = getCircuit(model);
  c.state = "closed";
  c.failures = 0;
  c.openedAt = null;
}

function recordFailure(model: string): void {
  const cfg = loadGatewayConfig().circuitBreaker;
  const c = getCircuit(model);
  c.failures += 1;
  if (c.failures >= cfg.failureThreshold) {
    c.state = "open";
    c.openedAt = Date.now();
    console.warn(`[gateway] circuit OPEN for ${model} after ${c.failures} failures`);
  }
}

function isAvailable(model: string): boolean {
  const cfg = loadGatewayConfig().circuitBreaker;
  const c = getCircuit(model);
  if (c.state === "closed") return true;
  if (c.state === "open" && c.openedAt !== null) {
    if (Date.now() - c.openedAt >= cfg.resetTimeoutMs) {
      c.state = "half-open";
      console.log(`[gateway] circuit HALF-OPEN for ${model}, probing`);
      return true;
    }
    return false;
  }
  return true; // half-open: allow one probe
}

export function getCircuitStates(): Record<string, { state: CircuitState; failures: number; openedAt: number | null }> {
  const result: Record<string, { state: CircuitState; failures: number; openedAt: number | null }> = {};
  for (const [model, entry] of circuits.entries()) {
    result[model] = { ...entry };
  }
  return result;
}

export function setCircuitStateForGatewayAdmin(model: string, state: CircuitState): CircuitEntry {
  const c = getCircuit(model);
  c.state = state;
  if (state === "closed") {
    c.failures = 0;
    c.openedAt = null;
  } else if (state === "half-open") {
    c.openedAt = null;
  } else {
    c.failures = Math.max(1, c.failures);
    c.openedAt = c.openedAt ?? Date.now();
  }
  return { ...c };
}

function activeRouteOverride(): GatewayRouteOverride | null {
  ensureRouteOverrideLoaded();
  if (!routeOverride) return null;
  if (Date.parse(routeOverride.expiresAt) <= Date.now()) {
    const expired = routeOverride;
    routeOverride = null;
    deletePersistedRouteOverride();
    try {
      writeActionAudit({
        actor: "gateway",
        actionKind: "gateway.route-override-expired",
        targetType: "gateway-route",
        targetId: expired.targetModel,
        risk: "low",
        resultStatus: "success",
      });
    } catch (error) {
      console.warn("[gateway] route override expiry audit failed", error);
    }
    return null;
  }
  return { ...routeOverride };
}

function inferTier(model: string): ModelTier {
  const lower = model.toLowerCase();
  if (lower.includes(":free") || lower.includes("-free") || lower.includes("/free") || lower.endsWith("free")) {
    return "cloud-free";
  }
  if (
    lower.includes("openrouter")
    || lower.includes("opencode/")
    || lower.includes("gemini")
    || lower.includes("nvidia/")
    || lower.includes("groq/")
    || lower.includes("cerebras/")
  ) {
    return "cloud-paid";
  }
  return "local";
}

function resolveGatewayEntry(modelName: string): ModelEntry {
  return resolveModel(modelName) ?? {
    backend: "litellm",
    model: modelName,
    tier: inferTier(modelName),
    fallbackChain: [],
  };
}

export function setGatewayRouteOverrideForGatewayAdmin(input: {
  targetModel: string;
  resolvedModel?: string;
  tier?: ModelTier;
  reason?: string;
  setBy?: string;
  ttlMs?: number;
}): GatewayRouteOverride {
  const now = Date.now();
  const ttlMs = Math.max(60_000, Math.min(input.ttlMs ?? 15 * 60_000, 7 * 86_400_000));
  const resolvedModel = input.resolvedModel ?? resolveModel(input.targetModel)?.model ?? input.targetModel;
  routeOverride = {
    targetModel: input.targetModel,
    resolvedModel,
    tier: input.tier ?? resolveModel(input.targetModel)?.tier ?? inferTier(input.targetModel),
    reason: input.reason,
    setAt: new Date(now).toISOString(),
    setBy: input.setBy ?? "operator",
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  routeOverrideLoaded = true;
  persistRouteOverride(routeOverride);
  return { ...routeOverride };
}

export function getGatewayRouteOverrideForGatewayAdmin(): GatewayRouteOverride | null {
  return activeRouteOverride();
}

export function clearGatewayRouteOverrideForGatewayAdmin(): void {
  routeOverride = null;
  routeOverrideLoaded = true;
  deletePersistedRouteOverride();
}

export function resetGatewayRouteOverrideStateForTests(): void {
  routeOverride = null;
  routeOverrideLoaded = false;
}

// ── Adapter cache ──────────────────────────────────────────────────────────────

const adapterCache = new Map<string, LiteLLMAdapter>();

function getAdapter(litellmUrl: string): LiteLLMAdapter {
  if (!adapterCache.has(litellmUrl)) adapterCache.set(litellmUrl, new LiteLLMAdapter(litellmUrl));
  return adapterCache.get(litellmUrl)!;
}

// ── Core complete() with fallback chain ───────────────────────────────────────

export type GatewayCompleteOptions = {
  timeoutMs?: number;
  traceId?: string | null;
  caller?: string;
};

export async function gatewayComplete(
  logicalModel: string,
  req: CompletionRequest,
  opts: GatewayCompleteOptions = {},
): Promise<CompletionResponse> {
  const cfg = loadGatewayConfig();
  const adapter = getAdapter(cfg.litellmUrl);

  const chain = buildChain(logicalModel);

  const budgetCheck = checkBudget("global");
  if (!budgetCheck.allowed) {
    try {
      writeActionAudit({
        actor: opts.caller ?? "gateway",
        actionKind: "gateway.budget-stop",
        targetType: "budget",
        targetId: "global",
        risk: "low",
        resultStatus: "blocked",
        request: { logicalModel },
        error: budgetCheck.reason,
      });
    } catch {
      /* audit is best-effort; never let it break the 429 path */
    }
    return Response.json(
      { error: { message: budgetCheck.reason ?? "BudgetExceeded", type: "budget_exceeded", cap: budgetCheck.cap, spent: budgetCheck.spent, period: budgetCheck.period } },
      { status: 429, headers: { "Content-Type": "application/json" } },
    ) as unknown as CompletionResponse;
  }

  let lastError: Error | null = null;

  for (const modelName of chain) {
    const entry = resolveGatewayEntry(modelName);
    if (!isAvailable(modelName)) {
      console.log(`[gateway] skipping ${modelName} (circuit open)`);
      continue;
    }

    const startMs = Date.now();
    try {
      const result = await adapter.complete(
        { ...req, model: entry.model },
        opts.timeoutMs ?? 120_000,
      );
      const latencyMs = Date.now() - startMs;
      recordSuccess(modelName);

      const costPerM = cfg.costEstimates[entry.tier] ?? { prompt: 0, completion: 0 };
      const promptT = result.usage?.prompt_tokens ?? null;
      const completionT = result.usage?.completion_tokens ?? null;
      const costEst = promptT != null && completionT != null
        ? (promptT * costPerM.prompt + completionT * costPerM.completion) / 1_000_000
        : null;

      writeLedgerEntry({
        logicalModel,
        resolvedModel: entry.model,
        backend: "litellm",
        tier: entry.tier,
        promptTokens: promptT,
        completionTokens: completionT,
        latencyMs,
        costEstimateUsd: costEst,
        success: true,
        errorClass: null,
        traceId: opts.traceId,
        caller: opts.caller,
      });

      return result;
    } catch (e) {
      const latencyMs = Date.now() - startMs;
      lastError = e instanceof Error ? e : new Error(String(e));
      const errorClass = classifyError(lastError);
      recordFailure(modelName);

      writeLedgerEntry({
        logicalModel,
        resolvedModel: entry.model,
        backend: "litellm",
        tier: entry.tier,
        promptTokens: null,
        completionTokens: null,
        latencyMs,
        costEstimateUsd: null,
        success: false,
        errorClass,
        traceId: opts.traceId,
        caller: opts.caller,
      });

      console.warn(`[gateway] ${modelName} failed (${errorClass}): ${lastError.message.slice(0, 100)}`);
    }
  }

  throw lastError ?? new Error(`All models in chain for ${logicalModel} are unavailable`);
}

function buildChain(logicalModel: string): string[] {
  const entry = resolveModel(logicalModel);
  const chain = entry ? [logicalModel, ...entry.fallbackChain] : [logicalModel];
  const override = activeRouteOverride();
  if (override) chain.unshift(override.targetModel);
  return Array.from(new Set(chain)); // passthrough — maybe LiteLLM knows it
}

export function getGatewayRoutePlanForGatewayAdmin(logicalModel: string): string[] {
  return buildChain(logicalModel);
}

function classifyError(e: Error): string {
  const msg = e.message.toLowerCase();
  if (msg.includes("timeout") || msg.includes("abort")) return "timeout";
  if (msg.includes("429") || msg.includes("rate limit")) return "rate_limit";
  if (msg.includes("401") || msg.includes("unauthorized")) return "auth";
  if (msg.includes("503") || msg.includes("unavailable")) return "unavailable";
  if (msg.includes("5")) return "server_error";
  return "unknown";
}

// ── Models listing ────────────────────────────────────────────────────────────

export async function gatewayModels(): Promise<ModelInfo[]> {
  const cfg = loadGatewayConfig();
  const adapter = getAdapter(cfg.litellmUrl);
  const upstream = await adapter.models();
  // Merge logical names from our config as canonical names
  const configModels = Object.keys(cfg.models).map((id) => ({
    id,
    object: "model" as const,
    owned_by: "tib-gateway",
  }));
  const upstreamIds = new Set(upstream.map((m) => m.id));
  const extras = configModels.filter((m) => !upstreamIds.has(m.id));
  return [...upstream, ...extras];
}
