import { getModelsDetail, type ModelEntry } from "../adapters/models.ts";
import type { BuilderWorkflowConfig } from "./store.ts";

export type ModelRole = "planner" | "builder" | "reviewer";

export interface ModelSelection {
  model: string | null;
  provider: string | null;
  reason: string;
  role: ModelRole;
  capability: string | null;
  qualityStatus: ModelEntry["qualityStatus"] | null;
}

function isModelHealthy(entry: ModelEntry): boolean {
  return entry.available && entry.qualityStatus === "healthy" && entry.latency !== null && entry.latency < 30000;
}

function isModelUsable(entry: ModelEntry): boolean {
  return entry.available && entry.qualityStatus !== "blocked";
}

function isOpenCodeNativeModel(model: string, agent: string): boolean {
  return agent === "opencode" && /^[a-z0-9][a-z0-9._:-]*\/[^\s]+$/i.test(model);
}

function isModelCompatibleWithAgent(model: string, agent: string): boolean {
  if (agent === "opencode") return isOpenCodeNativeModel(model, agent);
  if (agent === "codex") {
    // Codex CLI only supports OpenAI models
    return /^(gpt-|o[1-9])/i.test(model);
  }
  if (agent === "claude") {
    return /^claude-/i.test(model);
  }
  if (agent === "gemini") {
    return /^gemini-/i.test(model);
  }
  return true;
}

export function selectModelForRole(
  role: ModelRole,
  config: BuilderWorkflowConfig,
  agent: string,
): ModelSelection {
  const detail = getModelsDetail();
  const modelMap = new Map(detail.models.map((m) => [m.logicalName, m]));

  const preferredModel = config.modelPolicy[role] ?? null;

  if (agent === "opencode") {
    if (preferredModel && isOpenCodeNativeModel(preferredModel, agent)) {
      return {
        model: preferredModel,
        provider: agent,
        reason: `primary:${role}:opencode-native`,
        role,
        capability: null,
        qualityStatus: "healthy",
      };
    }
    return tryFallback(modelMap, config.modelPolicy.fallbackTargets, agent, role, preferredModel
      ? `preferred.${role}.${preferredModel}.not-opencode-native`
      : `no-preferred.${role}`);
  }

  if (preferredModel && modelMap.has(preferredModel)) {
    const entry = modelMap.get(preferredModel)!;
    if (isModelUsable(entry) && isModelCompatibleWithAgent(preferredModel, agent)) {
      return {
        model: preferredModel,
        provider: agent,
        reason: `primary:${role}`,
        role,
        capability: entry.capability || null,
        qualityStatus: entry.qualityStatus,
      };
    }
    const reason = !entry.available
      ? `preferred.${role}.${preferredModel}.unavailable`
      : !isModelCompatibleWithAgent(preferredModel, agent)
      ? `preferred.${role}.${preferredModel}.incompatible-with-${agent}`
      : `preferred.${role}.${preferredModel}.degraded:${entry.qualityStatus}`;
    return tryFallback(modelMap, config.modelPolicy.fallbackTargets, agent, role, reason);
  }

  if (preferredModel && isOpenCodeNativeModel(preferredModel, agent)) {
    return {
      model: preferredModel,
      provider: agent,
      reason: `primary:${role}:opencode-native`,
      role,
      capability: null,
      qualityStatus: "healthy",
    };
  }

  return tryFallback(modelMap, config.modelPolicy.fallbackTargets, agent, role, `no-preferred.${role}`);
}

function tryFallback(
  modelMap: Map<string, ModelEntry>,
  fallbackTargets: string[],
  agent: string,
  role: ModelRole,
  priorReason: string,
): ModelSelection {
  for (const candidate of fallbackTargets) {
    if (!isModelCompatibleWithAgent(candidate, agent)) continue;
    if (isOpenCodeNativeModel(candidate, agent)) {
      return {
        model: candidate,
        provider: agent,
        reason: `fallback:${priorReason}->${candidate}:opencode-native`,
        role,
        capability: null,
        qualityStatus: "healthy",
      };
    }
    if (agent === "opencode") continue;
    if (!modelMap.has(candidate)) continue;
    const entry = modelMap.get(candidate)!;
    if (!isModelUsable(entry)) continue;
    return {
      model: candidate,
      provider: agent,
      reason: `fallback:${priorReason}->${candidate}`,
      role,
      capability: entry.capability || null,
      qualityStatus: entry.qualityStatus,
    };
  }

  const usableModels = Array.from(modelMap.values()).filter(isModelUsable);
  if (agent === "opencode") {
    return {
      model: null,
      provider: agent,
      reason: `opencode-default:${priorReason}`,
      role,
      capability: null,
      qualityStatus: null,
    };
  }

  const compatibleUsableModels = usableModels.filter((m) => isModelCompatibleWithAgent(m.logicalName, agent));
  if (compatibleUsableModels.length > 0) {
    const healthyModels = compatibleUsableModels.filter(isModelHealthy);
    const pool = healthyModels.length > 0 ? healthyModels : compatibleUsableModels;
    const best = pool.reduce((a, b) =>
      (a.latency ?? Infinity) < (b.latency ?? Infinity) ? a : b
    );
    const healthNote = healthyModels.length === 0 ? " degraded-or-unknown" : "";
    return {
      model: best.logicalName,
      provider: agent,
      reason: `emergency-fallback:${priorReason}->${best.logicalName}${healthNote}`,
      role,
      capability: best.capability || null,
      qualityStatus: best.qualityStatus,
    };
  }

  return {
    model: null,
    provider: agent,
    reason: `no-model-available:${priorReason}`,
    role,
    capability: null,
    qualityStatus: null,
  };
}

export function getModelLabel(entry: ModelEntry): string {
  const providerTag = entry.provider === "local" ? "GPU" : entry.provider ?? "cloud";
  const capTag = entry.capability || "unknown";
  const healthTag = entry.qualityStatus !== "healthy" ? ` [${entry.qualityStatus}]` : "";
  return `${entry.logicalName} (${providerTag}/${capTag})${healthTag}`;
}

export interface CategorizedModels {
  heavy: ModelEntry[];
  medium: ModelEntry[];
  light: ModelEntry[];
  byProvider: Record<string, ModelEntry[]>;
  all: ModelEntry[];
}

export function getCategorizedModels(): CategorizedModels {
  const detail = getModelsDetail();
  const byCapability: CategorizedModels["heavy"] = [];
  const byMedium: CategorizedModels["medium"] = [];
  const byLight: CategorizedModels["light"] = [];
  const byProvider: Record<string, ModelEntry[]> = {};

  for (const m of detail.models) {
    if (m.capability === "heavy") byCapability.push(m);
    else if (m.capability === "medium") byMedium.push(m);
    else byLight.push(m);

    const prov = m.provider || "unknown";
    if (!byProvider[prov]) byProvider[prov] = [];
    byProvider[prov].push(m);
  }

  return {
    heavy: byCapability,
    medium: byMedium,
    light: byLight,
    byProvider,
    all: detail.models,
  };
}
