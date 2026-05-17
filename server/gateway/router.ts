import { loadGatewayConfig, resolveModel } from "./config.ts";
import { LiteLLMAdapter } from "./adapters/litellm.ts";
import { writeLedgerEntry } from "./ledger.ts";
import type { CompletionRequest, CompletionResponse, ModelInfo } from "./adapters/base.ts";
import { checkBudget } from "../governance/budgets.ts";

// ── Circuit breaker state (in-process, reset on restart) ──────────────────────

type CircuitState = "closed" | "open" | "half-open";

type CircuitEntry = {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
};

const circuits = new Map<string, CircuitEntry>();

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
    return Response.json(
      { error: { message: budgetCheck.reason ?? "BudgetExceeded", type: "budget_exceeded", cap: budgetCheck.cap, spent: budgetCheck.spent, period: budgetCheck.period } },
      { status: 429, headers: { "Content-Type": "application/json" } },
    ) as unknown as CompletionResponse;
  }

  let lastError: Error | null = null;

  for (const modelName of chain) {
    const entry = resolveModel(modelName);
    if (!entry) continue;
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
  if (!entry) return [logicalModel]; // passthrough — maybe LiteLLM knows it
  return [logicalModel, ...entry.fallbackChain];
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
