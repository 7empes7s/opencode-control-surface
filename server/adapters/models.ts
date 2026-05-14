import { readFileSync } from "node:fs";
import { openSync, fstatSync, readSync, closeSync } from "node:fs";

const MODEL_HEALTH_PATH = "/var/lib/mimule/model-health.json";
const MODEL_COOLDOWNS_PATH = "/var/lib/mimule/model-cooldowns.json";
const MODEL_QUALITY_PATH = "/var/lib/mimule/model-quality.json";
const MODEL_DISCOVERY_LOG_PATH = "/var/lib/mimule/model-discovery-log.jsonl";

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

function tailJsonlLines(path: string, maxLines = 100): string[] {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return []; }
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    const readSize = Math.min(64 * 1024, size);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, size - readSize));
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    if (size > readSize) lines.shift();
    return lines.slice(-maxLines);
  } finally { closeSync(fd); }
}

// ── Summary model (used by home handler) ─────────────────────────────────────

export interface ModelHealth {
  checkedAt: number;
  lastFullCheckAt: number;
  lastQuickCheckAt: number;
  bestLocal: string | null;
  bestCloudHeavy: string | null;
  bestCloudFast: string | null;
  availableByCapability: { heavy: number; medium: number; light: number };
  qualitySummary: { blocked: number; degraded: number; probation: number };
  newModelsAdded: string[];
  cooldownsActive: number;
  soonestCooldownExpiresMs: number | null;
}

export function getModelHealth(): ModelHealth {
  const health = readJson<Record<string, unknown>>(MODEL_HEALTH_PATH);
  const cooldowns = readJson<Record<string, { expiresAt?: number }>>(MODEL_COOLDOWNS_PATH) ?? {};
  const now = Date.now();

  const cooldownEntries = Object.values(cooldowns);
  const activeCooldowns = cooldownEntries.filter((c) => c?.expiresAt && c.expiresAt > now);
  const soonestExpiry = activeCooldowns.length > 0
    ? Math.min(...activeCooldowns.map((c) => c.expiresAt ?? Infinity))
    : null;

  if (!health) {
    return {
      checkedAt: 0, lastFullCheckAt: 0, lastQuickCheckAt: 0,
      bestLocal: null, bestCloudHeavy: null, bestCloudFast: null,
      availableByCapability: { heavy: 0, medium: 0, light: 0 },
      qualitySummary: { blocked: 0, degraded: 0, probation: 0 },
      newModelsAdded: [],
      cooldownsActive: activeCooldowns.length,
      soonestCooldownExpiresMs: soonestExpiry,
    };
  }

  const avail = (health.availableByCapability as Record<string, number>) ?? {};
  const quality = (health.qualitySummary as Record<string, number>) ?? {};

  return {
    checkedAt: (health.checkedAt as number) ?? 0,
    lastFullCheckAt: (health.lastFullCheckAt as number) ?? 0,
    lastQuickCheckAt: (health.lastQuickCheckAt as number) ?? 0,
    bestLocal: (health.bestLocal as string) ?? null,
    bestCloudHeavy: (health.bestCloudHeavy as string) ?? null,
    bestCloudFast: (health.bestCloudFast as string) ?? null,
    availableByCapability: { heavy: avail.heavy ?? 0, medium: avail.medium ?? 0, light: avail.light ?? 0 },
    qualitySummary: { blocked: quality.blocked ?? 0, degraded: quality.degraded ?? 0, probation: quality.probation ?? 0 },
    newModelsAdded: Array.isArray(health.newModelsAdded) ? (health.newModelsAdded as string[]) : [],
    cooldownsActive: activeCooldowns.length,
    soonestCooldownExpiresMs: soonestExpiry,
  };
}

// ── Detail model (used by /api/models handler) ────────────────────────────────

export interface ModelEntry {
  logicalName: string;
  provider: string;
  capability: string;
  available: boolean;
  latency: number | null;
  jsonOk: boolean;
  checkedAt: number;
  qualityStatus: "healthy" | "probation" | "degraded" | "blocked" | "unknown";
  recentFailures: number;
  consecutiveGarbage: number;
  isFree: boolean;
  isPaid: boolean;
  isOpenCode: boolean;
  isCli: boolean;
  providerType: "openrouter" | "groq" | "github" | "cerebras" | "local" | "zen" | "other";
  contextWindow: number | null;
  params: number | null;
  resolvedModel: string | null;
}

export interface CooldownEntry {
  model: string;
  startedAt: number | null;
  expiresAt: number;
  reason?: string;
}

export interface DiscoveryLogEntry {
  ts: string;
  newModelsAdded: string[];
  totalModelCount: number;
}

export interface ModelsDetailData {
  models: ModelEntry[];
  cooldowns: CooldownEntry[];
  fallbacks: Record<string, string[]>;
  summary: {
    bestCloudHeavy: string | null;
    bestCloudFast: string | null;
    bestLocal: string | null;
    availableByCapability: { heavy: number; medium: number; light: number };
    qualitySummary: { blocked: number; degraded: number; probation: number };
    lastFullCheckAgo: number;
    lastQuickCheckAgo: number;
    newModelsAdded: string[];
  };
  discoveryLog: DiscoveryLogEntry[];
}

function detectProviderType(name: string, provider: string): ModelEntry["providerType"] {
  const n = name.toLowerCase();
  if (n.includes("openrouter")) return "openrouter";
  if (n.includes("groq")) return "groq";
  if (n.includes("github")) return "github";
  if (n.includes("cerebras")) return "cerebras";
  if (n.includes("zen-") || n.includes("zen ")) return "zen";
  if (provider === "local" || name.startsWith("editorial-") || name.startsWith("coding-") || name.startsWith("mimule-")) return "local";
  return "other";
}

function detectPricing(name: string): { isFree: boolean; isPaid: boolean } {
  const n = name.toLowerCase();
  const freeKeywords = ["free", "trial", "-free", "no-cost", "openrouter-", "groq-", "github-", "cerebras-"];
  const paidKeywords = ["paid", "pro", "premium", "zen-", "groq-", "-paid"];

  const hasExplicitFree = freeKeywords.some(k => n.includes(k));
  const hasExplicitPaid = paidKeywords.some(k => n.includes(k));

  if (hasExplicitPaid) return { isFree: false, isPaid: true };
  if (hasExplicitFree || n.includes("openrouter") || n.includes("github") || n.includes("cerebras") || n.includes("groq")) {
    return { isFree: true, isPaid: false };
  }
  return { isFree: false, isPaid: true };
}

function detectCliRelated(name: string): boolean {
  const cliModels = ["codex", "claude", "opencode", "gemini", "ollama"];
  return cliModels.some(c => name.toLowerCase().includes(c));
}

function detectOpenCode(name: string): boolean {
  return name.startsWith("opencode-") || name.includes("opencode");
}

export function getModelsDetail(): ModelsDetailData {
  const health = readJson<Record<string, unknown>>(MODEL_HEALTH_PATH);
  const cooldownsRaw = readJson<Record<string, { expiresAt?: number; startedAt?: number; reason?: string }>>(MODEL_COOLDOWNS_PATH) ?? {};
  const qualityRaw = readJson<{ models?: Record<string, { status?: string; recentFailures?: number[]; consecutiveGarbage?: number }> }>(MODEL_QUALITY_PATH);

  const now = Date.now();
  const qualityModels = qualityRaw?.models ?? {};

  // Full model array
  const rawModels: ModelEntry[] = [];
  if (health && Array.isArray(health.models)) {
    for (const m of health.models as Array<Record<string, unknown>>) {
      const name = String(m.logicalName ?? "");
      const provider = String(m.provider ?? "");
      const q = qualityModels[name];
      const pricing = detectPricing(name);

      rawModels.push({
        logicalName: name,
        provider,
        capability: String(m.capability ?? ""),
        available: Boolean(m.available),
        latency: typeof m.latency === "number" ? m.latency : null,
        jsonOk: Boolean(m.jsonOk),
        checkedAt: typeof m.checkedAt === "number" ? m.checkedAt : 0,
        qualityStatus: (q?.status as ModelEntry["qualityStatus"]) ?? "unknown",
        recentFailures: q?.recentFailures?.length ?? 0,
        consecutiveGarbage: q?.consecutiveGarbage ?? 0,
        isFree: pricing.isFree,
        isPaid: pricing.isPaid,
        isOpenCode: detectOpenCode(name),
        isCli: detectCliRelated(name),
        providerType: detectProviderType(name, provider),
        contextWindow: typeof m.params === "number" && m.params >= 1000 ? m.params * 1000 : null,
        params: typeof m.params === "number" ? m.params : null,
        resolvedModel: typeof m.resolvedModel === "string" ? m.resolvedModel : null,
      });
    }
  }

  // Active cooldowns
  const cooldowns: CooldownEntry[] = Object.entries(cooldownsRaw)
    .filter(([, v]) => v?.expiresAt && v.expiresAt > now)
    .map(([model, v]) => ({
      model,
      startedAt: v.startedAt ?? null,
      expiresAt: v.expiresAt!,
      reason: v.reason,
    }));

  // Fallback chains
  const fallbacks = (health?.fallbacks as Record<string, string[]>) ?? {};

  // Summary
  const avail = (health?.availableByCapability as Record<string, number>) ?? {};
  const qsum = (health?.qualitySummary as Record<string, number>) ?? {};
  const summary = {
    bestCloudHeavy: (health?.bestCloudHeavy as string) ?? null,
    bestCloudFast: (health?.bestCloudFast as string) ?? null,
    bestLocal: (health?.bestLocal as string) ?? null,
    availableByCapability: { heavy: avail.heavy ?? 0, medium: avail.medium ?? 0, light: avail.light ?? 0 },
    qualitySummary: { blocked: qsum.blocked ?? 0, degraded: qsum.degraded ?? 0, probation: qsum.probation ?? 0 },
    lastFullCheckAgo: health ? Math.round((now - ((health.lastFullCheckAt as number) ?? 0)) / 1000) : 0,
    lastQuickCheckAgo: health ? Math.round((now - ((health.lastQuickCheckAt as number) ?? 0)) / 1000) : 0,
    newModelsAdded: Array.isArray(health?.newModelsAdded) ? (health!.newModelsAdded as string[]) : [],
  };

  // Discovery log
  const discoveryLog: DiscoveryLogEntry[] = [];
  for (const line of tailJsonlLines(MODEL_DISCOVERY_LOG_PATH, 100)) {
    try { discoveryLog.push(JSON.parse(line) as DiscoveryLogEntry); } catch {}
  }

  return { models: rawModels, cooldowns, fallbacks, summary, discoveryLog };
}
