import { readFileSync } from 'fs';

function detectProviderType(modelName: string, provider: string): "openrouter" | "groq" | "github" | "cerebras" | "local" | "zen" | "nvidia" | "cloudflare" | "opencode" | "alibaba" | "other" {
  const n = modelName.toLowerCase();
  const p = provider?.toLowerCase() ?? "";
  if (p === "zen") return "zen";
  if (p === "github") return "github";
  if (p === "groq") return "groq";
  if (p === "cerebras") return "cerebras";
  if (p === "alibaba" || n.startsWith("alibaba/")) return "alibaba";
  if (p === "opencode" || n.startsWith("opencode-go/")) return "opencode";
  if (p === "nvidia" || n.includes("nvidia")) return "nvidia";
  if (p === "cloudflare" || n.includes("cf-") || n.includes("cloudflare")) return "cloudflare";
  if (p === "local" || modelName.startsWith("editorial-") || modelName.startsWith("coding-") || modelName.startsWith("mimule-")) return "local";
  if (n.includes("openrouter")) return "openrouter";
  return "other";
}

function detectIsCli(modelName: string): boolean {
  const n = modelName.toLowerCase();
  return n.includes("codex") || n.includes("claude") || n.includes("opencode") || n.includes("gemini");
}

function detectIsOpenCode(modelName: string): boolean {
  const n = modelName.toLowerCase();
  return n.includes("opencode") || n.startsWith("oc-") || n.startsWith("alibaba/");
}

function computeQualityStatus(available: boolean, hasError: boolean): "healthy" | "probation" | "degraded" | "blocked" | "unknown" {
  if (!available && hasError) return "blocked";
  if (!available) return "degraded";
  if (hasError) return "probation";
  return "healthy";
}

export function modelsHandler(): Response {
  try {
    const raw = readFileSync('/var/lib/mimule/model-health.json', 'utf8');
    const health = JSON.parse(raw);

    const models = health.models.map((m: any) => {
      const providerType = detectProviderType(m.logicalName, m.provider);
      const hasExplicitFree = m.modelId?.includes('free') || m.logicalName?.includes('free');
      const isFree = hasExplicitFree || m.provider === 'openrouter' || m.provider === 'groq' || m.provider === 'cerebras';
      // Alibaba and OpenCode-native models are subscription/included — neither free nor pay-per-use
      const isSubscription = m.provider === 'alibaba' || m.provider === 'opencode' || m.logicalName?.startsWith('alibaba/') || m.logicalName?.startsWith('opencode-go/');
      const isPaid = !isFree && !isSubscription;
      const isCli = detectIsCli(m.logicalName);
      const isOpenCode = detectIsOpenCode(m.logicalName);
      const hasError = !!m.error;
      const available = m.available ?? false;
      const contextWindow = m.contextWindow || (m.params >= 200 ? 131072 : m.params >= 70 ? 32768 : 8192);

      return {
        logicalName: m.logicalName,
        provider: m.provider,
        capability: m.capability ?? "light",
        available,
        latency: m.latency ?? null,
        jsonOk: available && !hasError,
        checkedAt: m.checkedAt ?? 0,
        qualityStatus: computeQualityStatus(available, hasError),
        recentFailures: hasError ? 1 : 0,
        consecutiveGarbage: 0,
        isFree,
        isPaid,
        isOpenCode,
        isCli,
        providerType,
        contextWindow,
        params: m.params ?? null,
        resolvedModel: m.resolvedModel ?? m.modelId ?? m.logicalName,
        tier: m.provider === 'zen' ? (m.modelId?.includes('free') ? 'zen-free' : 'zen-paid') : m.provider,
        rating: Math.round((10000 / (m.latency || 1000)) * 10) / 10,
        errorCount: hasError ? 1 : 0,
        lastError: m.error ?? null,
        uptime: available ? '✅' : '❌',
        latencyMs: m.latency ?? 0,
      };
    });

    const summary = {
      bestCloudHeavy: health.bestCloudHeavy ?? null,
      bestCloudFast: health.bestCloudFast ?? null,
      bestLocal: health.bestLocal ?? null,
      availableByCapability: health.availableByCapability ?? { heavy: 0, medium: 0, light: 0 },
      qualitySummary: health.qualitySummary ?? { blocked: 0, degraded: 0, probation: 0 },
      lastFullCheckAgo: Date.now() - (health.lastFullCheckAt ?? 0),
      lastQuickCheckAgo: Date.now() - (health.lastQuickCheckAt ?? 0),
      newModelsAdded: health.newModelsAdded ?? [],
    };

    return Response.json({
      data: {
        models,
        cooldowns: [],
        fallbacks: health.fallbacks ?? {},
        summary,
        discoveryLog: [],
      }
    });
  } catch (e) {
    console.error('modelsHandler failed:', e);
    return Response.json({ error: 'model-health.json unreadable' }, { status: 500 });
  }
}