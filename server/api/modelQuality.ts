import { readFileSync, writeFileSync, existsSync } from "node:fs";

export type ModelQualityStatus = "healthy" | "probation" | "degraded" | "blocked";

export interface ModelQualityEntry {
  status?: ModelQualityStatus | string;
  recentFailures?: number[] | number;
  consecutiveGarbage?: number;
  [key: string]: unknown;
}

export interface ModelQualityFile {
  models: Record<string, ModelQualityEntry>;
  [key: string]: unknown;
}

export function modelQualityPath(): string {
  return process.env.DASHBOARD_MODEL_QUALITY_PATH || "/var/lib/mimule/model-quality.json";
}

export function readModelQuality(path = modelQualityPath()): ModelQualityFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelQualityFile>;
    return {
      ...parsed,
      models: parsed.models && typeof parsed.models === "object" ? parsed.models : {},
    };
  } catch {
    return { models: {} };
  }
}

export function writeModelQuality(quality: ModelQualityFile, path = modelQualityPath()): void {
  writeFileSync(path, JSON.stringify({ ...quality, models: quality.models ?? {} }, null, 2));
}

export function getModelQualityEntry(
  quality: ModelQualityFile,
  logicalName: string,
  modelId?: string | null,
): ModelQualityEntry | undefined {
  return (modelId ? quality.models[modelId] : undefined) ?? quality.models[logicalName];
}

export function clearModelCooldown(model: string, cooldownsPath?: string): void {
  const path = cooldownsPath ?? (process.env.DASHBOARD_MODEL_COOLDOWNS_PATH || "/var/lib/mimule/model-cooldowns.json");
  let cooldowns: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { cooldowns = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch {}
  }
  delete cooldowns[model];
  writeFileSync(path, JSON.stringify(cooldowns, null, 2));
}

export function setModelQualityStatus(
  model: string,
  status: ModelQualityStatus,
  path = modelQualityPath(),
): ModelQualityEntry {
  const quality = readModelQuality(path);
  const existing = quality.models[model] ?? {};
  const next: ModelQualityEntry = { ...existing, status };
  if (status === "healthy") {
    next.recentFailures = 0;
    next.consecutiveGarbage = 0;
  }
  quality.models[model] = next;
  writeModelQuality(quality, path);
  return next;
}
