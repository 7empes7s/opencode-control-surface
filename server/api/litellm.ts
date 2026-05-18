import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

type LiteLLMServiceStatus = {
  activeState: string;
  subState: string;
  mainPid: number | null;
  startedAt: string | null;
  memoryBytes: number | null;
  restarts: number | null;
  unitPath: string | null;
};

type LiteLLMModel = {
  name: string;
  backendModel: string | null;
  apiBase: string | null;
  provider: string;
  timeoutSeconds: number | null;
  hasApiKeyRef: boolean;
};

type LiteLLMFallback = {
  model: string;
  fallbacks: string[];
};

type LiteLLMConfigSummary = {
  path: string;
  exists: boolean;
  lineCount: number;
  modelCount: number;
  models: LiteLLMModel[];
  fallbacks: LiteLLMFallback[];
  redactedYaml: string;
};

export type LiteLLMHealthProbe = {
  url: string;
  reachable: boolean;
  healthStatus: number | null;
  healthOk: boolean;
  latencyMs: number | null;
  authConfigured: boolean;
  authRequired: boolean;
  error: string | null;
};

const DEFAULT_CONFIG_PATH = "/etc/litellm/config.yaml";
const DEFAULT_ENV_PATH = "/etc/litellm/litellm.env";
const DEFAULT_LITELLM_URL = "http://127.0.0.1:4000";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json({ data }, init);
}

function getConfigPath(): string {
  return process.env.LITELLM_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

function getEnvPath(): string {
  return process.env.LITELLM_ENV_PATH ?? DEFAULT_ENV_PATH;
}

function getLiteLLMUrl(): string {
  return (process.env.LITELLM_URL ?? DEFAULT_LITELLM_URL).replace(/\/$/, "");
}

function readEnvValue(key: string): string | null {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;

  const envPath = getEnvPath();
  if (!existsSync(envPath)) return null;

  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      if (trimmed.slice(0, eq) !== key) continue;
      return trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    }
  } catch {
    return null;
  }

  return null;
}

function parseSystemdShow(raw: string): LiteLLMServiceStatus {
  const props: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
  }

  const pid = Number(props.MainPID ?? 0);
  const memory = Number(props.MemoryCurrent ?? 0);
  const restarts = Number(props.NRestarts ?? 0);

  return {
    activeState: props.ActiveState ?? "unknown",
    subState: props.SubState ?? "unknown",
    mainPid: pid > 0 ? pid : null,
    startedAt: props.ExecMainStartTimestamp || null,
    memoryBytes: memory > 0 ? memory : null,
    restarts: Number.isFinite(restarts) ? restarts : null,
    unitPath: props.FragmentPath || null,
  };
}

function getServiceStatus(): LiteLLMServiceStatus {
  try {
    const raw = execFileSync("systemctl", [
      "show",
      "litellm.service",
      "--property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,MemoryCurrent,NRestarts,FragmentPath",
      "--no-pager",
    ], { encoding: "utf8", timeout: 3000 });
    return parseSystemdShow(raw);
  } catch {
    return {
      activeState: "unknown",
      subState: "unknown",
      mainPid: null,
      startedAt: null,
      memoryBytes: null,
      restarts: null,
      unitPath: null,
    };
  }
}

function redactConfig(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      if (/^\s*(api_key|master_key|password|token|secret|credential)\s*:/i.test(line)) {
        return line.replace(/:\s*.*/, ": [redacted]");
      }
      return line;
    })
    .join("\n");
}

function valueFromLine(block: string, key: string): string | null {
  const match = block.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
}

function detectProvider(backendModel: string | null, apiBase: string | null): string {
  const combined = `${backendModel ?? ""} ${apiBase ?? ""}`.toLowerCase();
  if (combined.includes("ollama")) return "ollama";
  if (combined.includes("openrouter")) return "openrouter";
  if (combined.includes("groq")) return "groq";
  if (combined.includes("cerebras")) return "cerebras";
  if (combined.includes("github")) return "github";
  if (combined.includes("opencode.ai/zen")) return "zen";
  if (combined.includes("cloudflare") || combined.includes("/@cf/")) return "cloudflare";
  if (combined.includes("nvidia")) return "nvidia";
  if (combined.includes("gemini")) return "google";
  return "other";
}

export function parseLiteLLMConfig(raw: string, path = getConfigPath()): LiteLLMConfigSummary {
  const models: LiteLLMModel[] = [];
  const modelBlockPattern = /^\s*-\s*model_name:\s*(.+?)\s*$([\s\S]*?)(?=^\s*-\s*model_name:|^router_settings:|^litellm_settings:|^general_settings:|$(?![\s\S]))/gm;
  let match: RegExpExecArray | null;

  while ((match = modelBlockPattern.exec(raw)) !== null) {
    const name = match[1].trim().replace(/^["']|["']$/g, "");
    const block = match[2];
    const backendModel = valueFromLine(block, "model");
    const apiBase = valueFromLine(block, "api_base");
    const timeoutRaw = valueFromLine(block, "timeout");
    const timeoutSeconds = timeoutRaw == null ? null : Number(timeoutRaw);

    models.push({
      name,
      backendModel,
      apiBase,
      provider: detectProvider(backendModel, apiBase),
      timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : null,
      hasApiKeyRef: /^\s*api_key:/m.test(block),
    });
  }

  const fallbacks: LiteLLMFallback[] = [];
  for (const line of raw.split("\n")) {
    const fallbackMatch = line.match(/^\s*-\s*([^:]+):\s*\[(.*)\]\s*$/);
    if (!fallbackMatch) continue;
    fallbacks.push({
      model: fallbackMatch[1].trim(),
      fallbacks: fallbackMatch[2].split(",").map((entry) => entry.trim()).filter(Boolean),
    });
  }

  return {
    path,
    exists: true,
    lineCount: raw.split("\n").length,
    modelCount: models.length,
    models,
    fallbacks,
    redactedYaml: redactConfig(raw),
  };
}

function readConfigSummary(): LiteLLMConfigSummary {
  const path = getConfigPath();
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      lineCount: 0,
      modelCount: 0,
      models: [],
      fallbacks: [],
      redactedYaml: "",
    };
  }

  return parseLiteLLMConfig(readFileSync(path, "utf8"), path);
}

async function fetchProxyJson(pathname: string, key: string | null): Promise<{
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  body: unknown;
  error: string | null;
}> {
  const started = Date.now();
  try {
    const response = await fetch(`${getLiteLLMUrl()}${pathname}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(2500),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      body,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function modelCountFromResponse(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  return Array.isArray(data) ? data.length : null;
}

export async function getLiteLLMHealthProbe(): Promise<LiteLLMHealthProbe> {
  const key = readEnvValue("LITELLM_MASTER_KEY");
  const health = await fetchProxyJson("/health", key);

  return {
    url: getLiteLLMUrl(),
    reachable: health.status != null,
    healthStatus: health.status,
    healthOk: health.ok,
    latencyMs: health.latencyMs,
    authConfigured: key != null,
    authRequired: health.status === 401,
    error: health.error,
  };
}

export async function litellmStatusHandler(): Promise<Response> {
  const key = readEnvValue("LITELLM_MASTER_KEY");
  const health = await fetchProxyJson("/health", key);
  const models = await fetchProxyJson("/v1/models", key);
  const config = readConfigSummary();

  return json({
    service: getServiceStatus(),
    proxy: {
      url: getLiteLLMUrl(),
      reachable: health.status != null || models.status != null,
      healthStatus: health.status ?? models.status,
      healthOk: health.ok || models.ok,
      modelsStatus: models.status,
      modelCount: modelCountFromResponse(models.body),
      latencyMs: health.ok ? health.latencyMs : models.latencyMs,
      authConfigured: key != null,
      authRequired: health.status === 401 || models.status === 401,
      error: health.error ?? models.error,
    },
    config: {
      path: config.path,
      exists: config.exists,
      modelCount: config.modelCount,
      fallbackChainCount: config.fallbacks.length,
    },
  });
}

export function litellmRoutingHandler(): Response {
  const config = readConfigSummary();
  return json({
    configPath: config.path,
    modelCount: config.modelCount,
    models: config.models.map((model) => ({
      ...model,
      fallbackCount: config.fallbacks.find((fallback) => fallback.model === model.name)?.fallbacks.length ?? 0,
    })),
    fallbacks: config.fallbacks,
  });
}

export function litellmConfigHandler(): Response {
  const config = readConfigSummary();
  return json(config);
}
