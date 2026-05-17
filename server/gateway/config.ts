import { readFileSync, existsSync } from "node:fs";

const CONFIG_PATH = process.env.GATEWAY_CONFIG ?? "/etc/tib-builder/gateway.yaml";

export type ModelTier = "local" | "cloud-free" | "cloud-paid";

export type ModelEntry = {
  backend: "litellm";
  model: string;
  tier: ModelTier;
  fallbackChain: string[];
};

export type CircuitBreakerConfig = {
  failureThreshold: number;
  resetTimeoutMs: number;
  probeTimeoutMs: number;
};

export type CostEstimate = { prompt: number; completion: number };

export type GatewayConfig = {
  version: number;
  litellmUrl: string;
  models: Record<string, ModelEntry>;
  circuitBreaker: CircuitBreakerConfig;
  costEstimates: Record<ModelTier, CostEstimate>;
};

let cached: GatewayConfig | null = null;
let cachedAt = 0;
const CACHE_TTL = 60_000;

function parseYaml(raw: string): Record<string, unknown> {
  // Minimal YAML parser sufficient for our flat config (no anchors/aliases needed)
  // Relies on the structure being simple key-value + lists + nested objects.
  const lines = raw.split("\n");
  const root: Record<string, unknown> = {};
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [{ obj: root, indent: -1 }];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Pop stack until we're at the right level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    if (trimmed.startsWith("- ")) {
      // List item
      const val = trimmed.slice(2).trim();
      const key = Object.keys(parent).at(-1) ?? "";
      if (!Array.isArray(parent[key])) parent[key] = [];
      (parent[key] as unknown[]).push(val);
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === "" || rest === "{}" || rest === "[]") {
      parent[key] = rest === "[]" ? [] : {};
      stack.push({ obj: parent[key] as Record<string, unknown>, indent });
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      parent[key] = rest.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      parent[key] = rest.replace(/^["']|["']$/g, "");
    }
  }

  return root;
}

export function loadGatewayConfig(): GatewayConfig {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;

  if (!existsSync(CONFIG_PATH)) {
    return defaultConfig();
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;

    const modelsRaw = (parsed.models ?? {}) as Record<string, Record<string, unknown>>;
    const models: Record<string, ModelEntry> = {};
    for (const [name, entry] of Object.entries(modelsRaw)) {
      models[name] = {
        backend: "litellm",
        model: String(entry.model ?? name),
        tier: (entry.tier as ModelTier) ?? "local",
        fallbackChain: Array.isArray(entry.fallback_chain) ? (entry.fallback_chain as string[]) : [],
      };
    }

    const cb = (parsed.circuit_breaker ?? {}) as Record<string, unknown>;
    const ce = (parsed.cost_estimates ?? {}) as Record<string, Record<string, unknown>>;

    cached = {
      version: Number(parsed.version ?? 1),
      litellmUrl: String(parsed.litellm_url ?? "http://127.0.0.1:4000"),
      models,
      circuitBreaker: {
        failureThreshold: Number(cb.failure_threshold ?? 3),
        resetTimeoutMs: Number(cb.reset_timeout_ms ?? 60_000),
        probeTimeoutMs: Number(cb.probe_timeout_ms ?? 8_000),
      },
      costEstimates: {
        local: { prompt: Number(ce.local?.prompt ?? 0), completion: Number(ce.local?.completion ?? 0) },
        "cloud-free": { prompt: Number(ce["cloud-free"]?.prompt ?? 0), completion: Number(ce["cloud-free"]?.completion ?? 0) },
        "cloud-paid": { prompt: Number(ce["cloud-paid"]?.prompt ?? 2), completion: Number(ce["cloud-paid"]?.completion ?? 8) },
      },
    };
    cachedAt = now;
    return cached;
  } catch (e) {
    console.error("[gateway] config load failed:", e);
    return defaultConfig();
  }
}

function defaultConfig(): GatewayConfig {
  return {
    version: 1,
    litellmUrl: "http://127.0.0.1:4000",
    models: {},
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 60_000, probeTimeoutMs: 8_000 },
    costEstimates: {
      local: { prompt: 0, completion: 0 },
      "cloud-free": { prompt: 0, completion: 0 },
      "cloud-paid": { prompt: 2, completion: 8 },
    },
  };
}

export function resolveModel(logicalName: string): ModelEntry | null {
  const cfg = loadGatewayConfig();
  return cfg.models[logicalName] ?? null;
}
