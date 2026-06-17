import { readFileSync } from 'fs';
import { getObservabilityDb, listLiteLLMRoutingLogs, listSystemConfigs, upsertSystemConfig, insertConfigChange } from '../db/observability.ts';
import { getModelQualityEntry, readModelQuality } from './modelQuality.ts';

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

function modelHealthPath(): string {
  return process.env.DASHBOARD_MODEL_HEALTH_PATH || '/var/lib/mimule/model-health.json';
}

function computeQualityStatus(available: boolean, hasError: boolean): "healthy" | "probation" | "degraded" | "blocked" | "unknown" {
  if (!available) return "degraded";
  if (hasError) return "probation";
  return "healthy";
}

export function modelsHandler(): Response {
  try {
    const raw = readFileSync(modelHealthPath(), 'utf8');
    const health = JSON.parse(raw);
    const quality = readModelQuality();

    const models = health.models.map((m: any) => {
      const qualityEntry = getModelQualityEntry(quality, m.logicalName, m.modelId);
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

      const qualityStatus = m.qualityStatus ?? qualityEntry?.status ?? computeQualityStatus(available, hasError);
      const pricingTier = m.pricingTier ?? (isFree ? 'free-rate-limited' : isPaid ? 'api-paid' : 'subscription');
      const recentFailures = Array.isArray(qualityEntry?.recentFailures)
        ? qualityEntry.recentFailures.length
        : typeof qualityEntry?.recentFailures === "number"
          ? qualityEntry.recentFailures
          : hasError ? 1 : 0;

      return {
        logicalName: m.logicalName,
        provider: m.provider,
        capability: m.capability ?? "light",
        available,
        latency: m.latency ?? null,
        jsonOk: m.jsonOk ?? (available && !hasError),
        checkedAt: m.checkedAt ?? 0,
        qualityStatus,
        recentFailures,
        consecutiveGarbage: Number(qualityEntry?.consecutiveGarbage ?? 0),
        isFree,
        isPaid,
        isOpenCode,
        isCli,
        providerType,
        contextWindow,
        params: m.params ?? null,
        resolvedModel: m.resolvedModel ?? m.modelId ?? m.logicalName,
        tier: m.provider === 'zen' ? (m.modelId?.includes('free') ? 'zen-free' : 'zen-paid') : m.provider,
        pricingTier,
        rating100: m.rating100 ?? null,
        ratingBreakdown: m.ratingBreakdown ?? null,
        workloadScores: m.workloadScores ?? null,
        errorCount: hasError ? 1 : 0,
        lastError: m.error ?? null,
        uptime: available ? '✅' : '❌',
        latencyMs: m.latency ?? 0,
      };
    });
    const qualitySummary = models.reduce((acc: { blocked: number; degraded: number; probation: number }, model: any) => {
      if (model.qualityStatus === "blocked") acc.blocked += 1;
      if (model.qualityStatus === "degraded") acc.degraded += 1;
      if (model.qualityStatus === "probation") acc.probation += 1;
      return acc;
    }, { blocked: 0, degraded: 0, probation: 0 });

    const summary = {
      bestCloudHeavy: health.bestCloudHeavy ?? null,
      bestCloudFast: health.bestCloudFast ?? null,
      bestLocal: health.bestLocal ?? null,
      availableByCapability: health.availableByCapability ?? { heavy: 0, medium: 0, light: 0 },
      qualitySummary,
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

export async function getRoutingLogs(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "100");

    const db = getObservabilityDb();
    if (!db) {
      return new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const logs = listLiteLLMRoutingLogs(db, limit);

    return Response.json({
      data: logs,
      pagination: {
        limit,
        count: logs.length
      }
    });
  } catch (e) {
    console.error('getRoutingLogs failed:', e);
    return Response.json({ error: 'Failed to fetch routing logs' }, { status: 500 });
  }
}

export async function getRoutingStats(req: Request): Promise<Response> {
  try {
    const db = getObservabilityDb();
    if (!db) {
      return new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const stats = db.query(`
      SELECT 
        logical_name,
        COUNT(*) as total_requests,
        AVG(total_latency_ms) as avg_latency_ms,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'fallback' THEN 1 ELSE 0 END) as fallback_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
        AVG(prompt_tokens) as avg_prompt_tokens,
        AVG(completion_tokens) as avg_completion_tokens
      FROM litellm_routing_log 
      GROUP BY logical_name
      ORDER BY total_requests DESC
    `).all() as Array<{
      logical_name: string;
      total_requests: number;
      avg_latency_ms: number | null;
      success_count: number;
      fallback_count: number;
      failed_count: number;
      avg_prompt_tokens: number | null;
      avg_completion_tokens: number | null;
    }>;

    return Response.json({
      data: stats,
      summary: {
        totalRequests: stats.reduce((sum, row) => sum + row.total_requests, 0),
        totalSuccess: stats.reduce((sum, row) => sum + row.success_count, 0),
        totalFallback: stats.reduce((sum, row) => sum + row.fallback_count, 0),
        totalFailed: stats.reduce((sum, row) => sum + row.failed_count, 0)
      }
    });
  } catch (e) {
    console.error('getRoutingStats failed:', e);
    return Response.json({ error: 'Failed to fetch routing stats' }, { status: 500 });
  }
}

export async function forceRouteModel(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { logicalName, targetModel, reason = "Manual override" } = body;

    if (!logicalName || !targetModel) {
      return Response.json({ error: 'logicalName and targetModel are required' }, { status: 400 });
    }

    const db = getObservabilityDb();
    if (!db) {
      return new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const now = new Date().toISOString();
    const configValue = {
      targetModel,
      reason,
      setAt: now,
      setBy: "dashboard-user"
    };

    // Store in system_configs table
    upsertSystemConfig(db, {
      key: `force_route_${logicalName}`,
      value: JSON.stringify(configValue),
      description: `Force routing for ${logicalName} to ${targetModel}`,
      updated_at: now,
      updated_by: "dashboard"
    });

    // Log the config change
    insertConfigChange(db, {
      key: `force_route_${logicalName}`,
      old_value: null,
      new_value: JSON.stringify(configValue),
      changed_by: "dashboard",
      changed_at: now
    });

    return Response.json({ 
      success: true, 
      logicalName,
      targetModel,
      message: `Forced routing for ${logicalName} to ${targetModel}`
    });
  } catch (e) {
    console.error('forceRouteModel failed:', e);
    return Response.json({ error: 'Failed to force route model' }, { status: 500 });
  }
}

export async function clearForceRoute(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const logicalName = url.pathname.split('/').pop(); // Extract logicalName from /api/models/force-route/:logicalName

    if (!logicalName) {
      return Response.json({ error: 'Logical name is required' }, { status: 400 });
    }

    const db = getObservabilityDb();
    if (!db) {
      return new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Get the old value before deletion
    const existingConfig = db.query("SELECT value FROM system_configs WHERE key = ?").get(`force_route_${logicalName}`) as { value: string } | undefined;

    // Delete from system_configs table
    db.query("DELETE FROM system_configs WHERE key = ?").run(`force_route_${logicalName}`);

    // Log the removal
    if (existingConfig) {
      const now = new Date().toISOString();
      insertConfigChange(db, {
        key: `force_route_${logicalName}`,
        old_value: existingConfig.value || null,
        new_value: JSON.stringify({ removed: true }),
        changed_by: "dashboard",
        changed_at: now
      });
    }

    return Response.json({ 
      success: true, 
      logicalName,
      message: `Cleared force route for ${logicalName}`
    });
  } catch (e) {
    console.error('clearForceRoute failed:', e);
    return Response.json({ error: 'Failed to clear force route' }, { status: 500 });
  }
}
