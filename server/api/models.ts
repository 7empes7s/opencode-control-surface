import { getDashboardDb } from '../db/dashboard.ts';
import { writeActionAudit } from '../db/writer.ts';
import { getObservabilityDb, listLiteLLMRoutingLogs, listSystemConfigs, upsertSystemConfig, insertConfigChange } from '../db/observability.ts';
import { createApprovalRequest, expireStaleRequests, listApprovalRequests, type ApprovalRequest } from '../governance/approvals.ts';
import { getCurrentTenantContext } from '../tenancy/middleware.ts';
import { getModelQualityEntry, readModelQuality, type ModelQualityStatus } from './modelQuality.ts';
import { getUserIdForRequest } from '../governance/rbac.ts';
import { readJsonFileAtomic } from "../lib/atomicJson.ts";
import { getModelChainSyncPayload } from "../adapters/modelChainSync.ts";
import { ok } from "./types.ts";
import { deriveHealthState, type HealthBucket, type HealthSignals, type HealthState } from "./modelHealthState.ts";

export const PROMOTION_EVAL_SCORE_THRESHOLD = 0.75;
const PROMOTION_APPROVAL_WORKFLOW_PREFIX = "model-promotion";
const PROMOTION_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type QualityStatus = ModelQualityStatus | "unknown";

export interface ModelEvalSample {
  ts: number;
  score: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface ModelPromotionReadiness {
  gate: "ready" | "blocked" | "needs-approval";
  reasons: string[];
  threshold: {
    minEvalScore: number;
  };
}

function promotionWorkflowId(logicalName: string): string {
  return `${PROMOTION_APPROVAL_WORKFLOW_PREFIX}:${logicalName}`;
}

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

function reprobeStatePath(): string {
  return process.env.DASHBOARD_REPROBE_STATE_PATH || '/var/lib/mimule/model-fallback-reprobe.json';
}

type ModelProbeHistoryEntry = { code?: number | null; streak?: number | null; since?: number | null; ms?: number | null };
type ModelProbeHistory = Record<string, ModelProbeHistoryEntry>;
type ModelLedgerHealth = Required<Pick<HealthSignals,
  | "recentCalls"
  | "recentSuccesses"
  | "recentAuthErrors"
  | "recentRateLimitErrors"
  | "recentAvgLatencyMs"
  | "allTimeCalls"
  | "allTimeSuccesses"
>>;
type ModelRosterEntry = { logicalName: string; healthModel: Record<string, any> | null };

function optionalProbeNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number") return value;
  return undefined;
}

function readModelReprobeHistory(): ModelProbeHistory {
  const raw = readJsonFileAtomic<unknown>(reprobeStatePath(), { fallback: {} });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const history = (raw as { history?: unknown }).history;
  if (!history || typeof history !== "object" || Array.isArray(history)) return {};

  const normalized: ModelProbeHistory = {};
  for (const [logicalName, value] of Object.entries(history)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    normalized[logicalName] = {
      code: optionalProbeNumber(entry.code),
      streak: optionalProbeNumber(entry.streak),
      since: optionalProbeNumber(entry.since),
      ms: optionalProbeNumber(entry.ms),
    };
  }
  return normalized;
}

function readModelHealthLedger(): Map<string, ModelLedgerHealth> | null {
  const db = getDashboardDb();
  if (!db) return null;
  try {
    const cut7d = Date.now() - 7 * 86400 * 1000;
    const recentRows = db.query<{
      m: string;
      n: number;
      ok: number | null;
      auth: number | null;
      rl: number | null;
      avg_ms: number | null;
    }, [number]>(`
      SELECT resolved_model AS m,
        COUNT(*) AS n,
        SUM(success) AS ok,
        SUM(CASE WHEN error_class = 'auth' THEN 1 ELSE 0 END) AS auth,
        SUM(CASE WHEN error_class = 'rate_limit' THEN 1 ELSE 0 END) AS rl,
        AVG(latency_ms) AS avg_ms
      FROM gateway_calls
      WHERE ts >= ?
        AND backend != 'cli-direct'
        AND (error_class IS NULL OR error_class != 'gateway_unreachable')
      GROUP BY resolved_model
    `).all(cut7d);
    const allTimeRows = db.query<{
      m: string;
      n: number;
      ok: number | null;
    }, []>(`
      SELECT resolved_model AS m,
        COUNT(*) AS n,
        SUM(success) AS ok
      FROM gateway_calls
      WHERE backend != 'cli-direct'
        AND (error_class IS NULL OR error_class != 'gateway_unreachable')
      GROUP BY resolved_model
    `).all();

    const ledger = new Map<string, ModelLedgerHealth>();
    for (const row of allTimeRows) {
      if (typeof row.m !== "string" || row.m.length === 0) continue;
      ledger.set(row.m, {
        allTimeCalls: row.n,
        allTimeSuccesses: row.ok ?? 0,
        recentCalls: 0,
        recentSuccesses: 0,
        recentAuthErrors: 0,
        recentRateLimitErrors: 0,
        recentAvgLatencyMs: null,
      });
    }
    for (const row of recentRows) {
      if (typeof row.m !== "string" || row.m.length === 0) continue;
      const existing = ledger.get(row.m) ?? {
        allTimeCalls: 0,
        allTimeSuccesses: 0,
        recentCalls: 0,
        recentSuccesses: 0,
        recentAuthErrors: 0,
        recentRateLimitErrors: 0,
        recentAvgLatencyMs: null,
      };
      ledger.set(row.m, {
        ...existing,
        recentCalls: row.n,
        recentSuccesses: row.ok ?? 0,
        recentAuthErrors: row.auth ?? 0,
        recentRateLimitErrors: row.rl ?? 0,
        recentAvgLatencyMs: row.avg_ms,
      });
    }

    return ledger;
  } catch {
    return null;
  }
}

function modelLedgerKeys(logicalName: string, healthModel: Record<string, any> | null): string[] {
  if (!healthModel) return [logicalName];
  const primary = [healthModel.resolvedModel, healthModel.modelId, logicalName]
    .find((value): value is string => typeof value === "string" && value.length > 0) ?? logicalName;
  return primary === logicalName ? [logicalName] : [primary, logicalName];
}

function ledgerForModel(
  logicalName: string,
  healthModel: Record<string, any> | null,
  ledgerMap: Map<string, ModelLedgerHealth> | null,
): ModelLedgerHealth | null {
  if (!ledgerMap) return null;
  for (const key of modelLedgerKeys(logicalName, healthModel)) {
    const ledger = ledgerMap.get(key);
    if (ledger) return ledger;
  }
  return null;
}

function healthSignalsForModel(
  logicalName: string,
  healthModel: Record<string, any> | null,
  reprobeHistory: ModelProbeHistory,
  ledgerMap: Map<string, ModelLedgerHealth> | null,
): HealthSignals {
  const probe = reprobeHistory[logicalName];
  const ledger = ledgerForModel(logicalName, healthModel, ledgerMap);
  return {
    probeCode: probe?.code,
    probeMs: probe?.ms,
    probeStreak: probe?.streak,
    ...(ledger ?? {}),
    available: typeof healthModel?.available === "boolean" ? healthModel.available : null,
  };
}

function buildModelRoster(
  healthModels: Array<Record<string, any>>,
  reprobeHistory: ModelProbeHistory,
  ledgerMap: Map<string, ModelLedgerHealth> | null,
): ModelRosterEntry[] {
  const roster: ModelRosterEntry[] = [];
  const seen = new Set<string>();
  const claimedLedgerKeys = new Set<string>();

  // Preserve model-health ordering and metadata for established API rows. If a
  // malformed file repeats a logical name, the first authoritative row wins.
  for (const healthModel of healthModels) {
    if (!healthModel || typeof healthModel !== "object" || Array.isArray(healthModel)) continue;
    const logicalName = healthModel.logicalName;
    if (typeof logicalName !== "string" || logicalName.length === 0 || seen.has(logicalName)) continue;
    seen.add(logicalName);
    for (const key of modelLedgerKeys(logicalName, healthModel)) claimedLedgerKeys.add(key);
    roster.push({ logicalName, healthModel });
  }

  // Reprobe and ledger routes are both real observations even when the slower
  // model-health inventory has not learned about them yet. Append those names
  // in a stable order so pagination and rendering do not jump between reads.
  const observedOnly = new Set<string>();
  for (const logicalName of Object.keys(reprobeHistory)) {
    if (logicalName.length > 0 && !seen.has(logicalName)) observedOnly.add(logicalName);
  }
  for (const logicalName of ledgerMap?.keys() ?? []) {
    if (logicalName.length > 0 && !seen.has(logicalName) && !claimedLedgerKeys.has(logicalName)) observedOnly.add(logicalName);
  }

  for (const logicalName of [...observedOnly].sort()) {
    roster.push({ logicalName, healthModel: null });
  }
  return roster;
}

function computeQualityStatus(available: boolean, hasError: boolean): "healthy" | "probation" | "degraded" | "blocked" | "unknown" {
  if (!available) return "degraded";
  if (hasError) return "probation";
  return "healthy";
}

function safeDecodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeRecentFailures(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function readHealthModel(logicalName: string): { qualityStatus: QualityStatus; recentFailures: number; consecutiveGarbage: number; resolvedModel: string | null } {
  try {
    const health = readJsonFileAtomic<{ models?: Array<Record<string, unknown>> }>(modelHealthPath());
    const model = (health.models ?? []).find((candidate) => candidate.logicalName === logicalName);
    const quality = readModelQuality();
    const modelId = typeof model?.modelId === "string" ? model.modelId : null;
    const qualityEntry = getModelQualityEntry(quality, logicalName, modelId);
    const available = Boolean(model?.available);
    const hasError = Boolean(model?.error);
    const rawStatus = typeof model?.qualityStatus === "string" ? model.qualityStatus : qualityEntry?.status;
    const qualityStatus = rawStatus === "healthy" || rawStatus === "probation" || rawStatus === "degraded" || rawStatus === "blocked"
      ? rawStatus
      : model ? computeQualityStatus(available, hasError) : "unknown";

    return {
      qualityStatus,
      recentFailures: normalizeRecentFailures(qualityEntry?.recentFailures),
      consecutiveGarbage: Number(qualityEntry?.consecutiveGarbage ?? 0),
      resolvedModel: typeof model?.resolvedModel === "string"
        ? model.resolvedModel
        : typeof model?.modelId === "string"
          ? model.modelId
          : null,
    };
  } catch {
    const quality = readModelQuality();
    const qualityEntry = getModelQualityEntry(quality, logicalName);
    const rawStatus = qualityEntry?.status;
    return {
      qualityStatus: rawStatus === "healthy" || rawStatus === "probation" || rawStatus === "degraded" || rawStatus === "blocked" ? rawStatus : "unknown",
      recentFailures: normalizeRecentFailures(qualityEntry?.recentFailures),
      consecutiveGarbage: Number(qualityEntry?.consecutiveGarbage ?? 0),
      resolvedModel: null,
    };
  }
}

function readEvalHistory(logicalName: string): { history: ModelEvalSample[]; firstSeen: number | null; lastEval: number | null } {
  const db = getDashboardDb();
  if (!db) return { history: [], firstSeen: null, lastEval: null };

  const ctx = getCurrentTenantContext();
  const tenantId = ctx.tenantId;
  const rows = db.query(`
    SELECT ts, value_json
    FROM metric_samples
    WHERE source = 'model-eval' AND key = ? AND (tenant_id = ? OR tenant_id IS NULL)
    ORDER BY ts DESC
    LIMIT 30
  `).all(logicalName, tenantId) as Array<{ ts: number; value_json: string }>;

  const history = rows.reverse().map((row) => {
    let parsed: { score?: unknown; latencyMs?: unknown; ts?: unknown; error?: unknown } = {};
    try {
      parsed = JSON.parse(row.value_json) as typeof parsed;
    } catch {
      parsed = {};
    }
    const sampleTs = typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : row.ts;
    return {
      ts: sampleTs,
      score: typeof parsed.score === "number" && Number.isFinite(parsed.score) ? parsed.score : null,
      latencyMs: typeof parsed.latencyMs === "number" && Number.isFinite(parsed.latencyMs) ? parsed.latencyMs : null,
      error: typeof parsed.error === "string" && parsed.error ? parsed.error : null,
    };
  });

  const first = db.query(`
    SELECT MIN(ts) AS firstSeen, MAX(ts) AS lastEval
    FROM metric_samples
    WHERE source = 'model-eval' AND key = ? AND (tenant_id = ? OR tenant_id IS NULL)
  `).get(logicalName, tenantId) as { firstSeen: number | null; lastEval: number | null } | null;

  return {
    history,
    firstSeen: first?.firstSeen ?? null,
    lastEval: first?.lastEval ?? null,
  };
}

function readRoutingReliability(logicalName: string): {
  totalRequests: number;
  successCount: number;
  fallbackCount: number;
  failedCount: number;
  avgLatencyMs: number | null;
} | null {
  const db = getDashboardDb();
  if (!db) return null;
  try {
    const row = db.query(`
      SELECT
        COUNT(*)                                     AS totalRequests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successCount,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failedCount,
        AVG(latency_ms)                              AS avgLatencyMs
      FROM gateway_calls
      WHERE resolved_model = ?
        AND backend != 'cli-direct'
        AND (error_class IS NULL OR error_class != 'gateway_unreachable')
    `).get(logicalName) as {
      totalRequests: number;
      successCount: number | null;
      failedCount: number | null;
      avgLatencyMs: number | null;
    } | null;
    if (!row || row.totalRequests === 0) {
      return { totalRequests: 0, successCount: 0, fallbackCount: 0, failedCount: 0, avgLatencyMs: null };
    }
    return {
      totalRequests: row.totalRequests,
      successCount: row.successCount ?? 0,
      // Per-hop fallback attribution requires trace_id grouping; do not fabricate it here.
      fallbackCount: 0,
      failedCount: row.failedCount ?? 0,
      avgLatencyMs: row.avgLatencyMs,
    };
  } catch {
    return null;
  }
}

function latestPromotionApproval(logicalName: string): ApprovalRequest | null {
  const ctx = getCurrentTenantContext();
  expireStaleRequests(ctx);
  const workflowId = promotionWorkflowId(logicalName);
  return listApprovalRequests(undefined, ctx)
    .filter((request) => request.workflowId === workflowId)
    .sort((a, b) => b.requestedAt - a.requestedAt)[0] ?? null;
}

function computePromotionReadiness(input: {
  evalHistory: ModelEvalSample[];
  qualityStatus: QualityStatus;
  recentFailures: number;
  consecutiveGarbage: number;
  approval: ApprovalRequest | null;
}): ModelPromotionReadiness {
  const reasons: string[] = [];
  const latestEval = input.evalHistory[input.evalHistory.length - 1] ?? null;

  if (!latestEval) {
    reasons.push("insufficient eval history");
  } else if (latestEval.error) {
    reasons.push(`latest model eval has an error: ${latestEval.error}`);
  } else if (typeof latestEval.score !== "number") {
    reasons.push("latest model eval is missing a numeric score");
  } else if (latestEval.score < PROMOTION_EVAL_SCORE_THRESHOLD) {
    reasons.push(`latest eval score ${latestEval.score.toFixed(2)} is below required ${PROMOTION_EVAL_SCORE_THRESHOLD.toFixed(2)}`);
  } else {
    reasons.push(`latest eval score ${latestEval.score.toFixed(2)} meets required ${PROMOTION_EVAL_SCORE_THRESHOLD.toFixed(2)}`);
  }

  if (input.qualityStatus !== "healthy") {
    reasons.push(`quality status is ${input.qualityStatus}`);
  } else {
    reasons.push("quality status is healthy");
  }

  if (input.recentFailures > 0) {
    reasons.push(`quality policy reports recent failures: ${input.recentFailures}`);
  } else {
    reasons.push("quality policy reports no recent failures");
  }

  if (input.consecutiveGarbage > 0) {
    reasons.push(`quality policy reports consecutive garbage outputs: ${input.consecutiveGarbage}`);
  } else {
    reasons.push("quality policy reports no consecutive garbage outputs");
  }

  const blocking = !latestEval
    || Boolean(latestEval.error)
    || typeof latestEval.score !== "number"
    || latestEval.score < PROMOTION_EVAL_SCORE_THRESHOLD
    || input.qualityStatus !== "healthy"
    || input.recentFailures > 0
    || input.consecutiveGarbage > 0
    || input.approval?.status === "rejected";

  if (input.approval?.status === "rejected") {
    reasons.push(`promotion approval ${input.approval.id} was rejected`);
  }

  if (blocking) {
    return { gate: "blocked", reasons, threshold: { minEvalScore: PROMOTION_EVAL_SCORE_THRESHOLD } };
  }

  if (input.approval?.status === "approved") {
    reasons.push(`promotion approval ${input.approval.id} is approved`);
    return { gate: "ready", reasons, threshold: { minEvalScore: PROMOTION_EVAL_SCORE_THRESHOLD } };
  }

  if (input.approval?.status === "pending") {
    reasons.push(`promotion approval ${input.approval.id} is pending`);
  } else if (input.approval?.status === "expired") {
    reasons.push(`previous promotion approval ${input.approval.id} expired`);
  } else {
    reasons.push("promotion approval is required");
  }

  return { gate: "needs-approval", reasons, threshold: { minEvalScore: PROMOTION_EVAL_SCORE_THRESHOLD } };
}

export function modelsHandler(): Response {
  try {
    type ModelHealthStateFile = {
      models?: Array<Record<string, any>>;
      bestCloudHeavy?: string | null;
      bestCloudFast?: string | null;
      bestLocal?: string | null;
      availableByCapability?: { heavy?: number; medium?: number; light?: number };
      lastFullCheckAt?: number;
      lastQuickCheckAt?: number;
      newModelsAdded?: string[];
      fallbacks?: Record<string, string[]>;
    };
    const rawHealth = readJsonFileAtomic<unknown>(modelHealthPath(), { fallback: {} });
    const health: ModelHealthStateFile = rawHealth && typeof rawHealth === "object" && !Array.isArray(rawHealth)
      ? rawHealth as ModelHealthStateFile
      : {};
    const quality = readModelQuality();
    const reprobeHistory = readModelReprobeHistory();
    const ledgerMap = readModelHealthLedger();

    const healthModels = Array.isArray(health.models) ? health.models : [];
    const roster = buildModelRoster(healthModels, reprobeHistory, ledgerMap);
    const models = roster.map(({ logicalName, healthModel: m }) => {
      const verdict = deriveHealthState(healthSignalsForModel(logicalName, m, reprobeHistory, ledgerMap));

      if (!m) {
        return {
          logicalName,
          provider: "unknown",
          capability: "unknown",
          available: false,
          latency: null,
          jsonOk: false,
          checkedAt: 0,
          qualityStatus: "unknown",
          recentFailures: 0,
          consecutiveGarbage: 0,
          healthState: verdict.state,
          healthBucket: verdict.bucket,
          healthReason: verdict.reason,
          isFree: false,
          isPaid: false,
          isOpenCode: false,
          isCli: false,
          providerType: "other" as const,
          contextWindow: null,
          params: null,
          resolvedModel: logicalName,
          tier: "unknown",
          pricingTier: "unknown",
          rating100: null,
          ratingBreakdown: null,
          workloadScores: null,
          errorCount: 0,
          lastError: null,
          uptime: "—",
          latencyMs: null,
        };
      }

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
        healthState: verdict.state,
        healthBucket: verdict.bucket,
        healthReason: verdict.reason,
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
    const healthStateSummary = models.reduce((acc: Record<HealthState, number>, model) => {
      acc[model.healthState] += 1;
      return acc;
    }, { live: 0, limited: 0, slow: 0, degraded: 0, dead: 0, hang: 0, unknown: 0 });
    const healthBucketSummary = models.reduce((acc: Record<HealthBucket, number>, model) => {
      acc[model.healthBucket] += 1;
      return acc;
    }, { healthy: 0, unhealthy: 0, unknown: 0 });

    const summary = {
      bestCloudHeavy: health.bestCloudHeavy ?? null,
      bestCloudFast: health.bestCloudFast ?? null,
      bestLocal: health.bestLocal ?? null,
      availableByCapability: health.availableByCapability ?? { heavy: 0, medium: 0, light: 0 },
      qualitySummary,
      healthStateSummary,
      healthBucketSummary,
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
    // Honest degrade: a fresh host with no model-health.json (or a transient
    // read error) is a known, expected state -- never surface a 500 for it.
    console.error('modelsHandler failed:', e);
    return Response.json({
      sourceStatus: { modelHealth: "error" },
      data: {
        models: [],
        cooldowns: [],
        fallbacks: {},
        summary: {
          bestCloudHeavy: null,
          bestCloudFast: null,
          bestLocal: null,
          availableByCapability: { heavy: 0, medium: 0, light: 0 },
          qualitySummary: { blocked: 0, degraded: 0, probation: 0 },
          healthStateSummary: { live: 0, limited: 0, slow: 0, degraded: 0, dead: 0, hang: 0, unknown: 0 },
          healthBucketSummary: { healthy: 0, unhealthy: 0, unknown: 0 },
          lastFullCheckAgo: 0,
          lastQuickCheckAgo: 0,
          newModelsAdded: [],
        },
        discoveryLog: [],
      },
    });
  }
}

export function modelChainSyncHandler(): Response {
  return Response.json(ok(getModelChainSyncPayload()));
}

export function modelLifecycleHandler(logicalNameParam: string): Response {
  try {
    const logicalName = safeDecodePathSegment(logicalNameParam);
    const quality = readHealthModel(logicalName);
    const evals = readEvalHistory(logicalName);
    const routingReliability = readRoutingReliability(logicalName);
    const approval = latestPromotionApproval(logicalName);
    const promotionReadiness = computePromotionReadiness({
      evalHistory: evals.history,
      qualityStatus: quality.qualityStatus,
      recentFailures: quality.recentFailures,
      consecutiveGarbage: quality.consecutiveGarbage,
      approval,
    });

    return Response.json({
      data: {
        logicalName,
        resolvedModel: quality.resolvedModel,
        evalHistory: evals.history,
        firstSeen: evals.firstSeen,
        lastEval: evals.lastEval,
        qualityStatus: quality.qualityStatus,
        recentFailures: quality.recentFailures,
        consecutiveGarbage: quality.consecutiveGarbage,
        routingReliability,
        approval: approval ? {
          id: approval.id,
          workflowId: approval.workflowId,
          runId: approval.runId,
          status: approval.status,
          requestedAt: approval.requestedAt,
          requestedBy: approval.requestedBy,
          requiredCount: approval.requiredCount,
          expiresAt: approval.expiresAt ?? null,
          decidedAt: approval.decidedAt ?? null,
          decidedBy: approval.decidedBy ?? null,
        } : null,
        promotionReadiness,
        unavailableCapabilities: [
          "Fairness and bias analysis is not available in this deployment because fairness datasets are not configured.",
          "XAI artifacts are not available in this deployment because no SHAP/LIME evaluator output exists.",
          "Adversarial model scans are not available in this deployment because model-scanning infrastructure is not configured.",
          "PDF compliance reports are not available in this deployment because no report generator is configured for model GRC evidence.",
        ],
      },
    });
  } catch (e) {
    console.error("modelLifecycleHandler failed:", e);
    return Response.json({ error: "Failed to load model lifecycle" }, { status: 500 });
  }
}

export async function modelPromotionRequestHandler(req: Request, logicalNameParam: string): Promise<Response> {
  try {
    const logicalName = safeDecodePathSegment(logicalNameParam);
    const body = await req.json().catch(() => ({})) as { reason?: unknown };
    const reason = typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "Request model promotion approval";
    const quality = readHealthModel(logicalName);
    const evals = readEvalHistory(logicalName);
    const approval = latestPromotionApproval(logicalName);
    const promotionReadiness = computePromotionReadiness({
      evalHistory: evals.history,
      qualityStatus: quality.qualityStatus,
      recentFailures: quality.recentFailures,
      consecutiveGarbage: quality.consecutiveGarbage,
      approval,
    });

    if (promotionReadiness.gate === "blocked") {
      return Response.json({
        error: "promotion gate is blocked",
        promotionReadiness,
      }, { status: 409 });
    }

    if (approval?.status === "pending" || approval?.status === "approved") {
      return Response.json({
        data: {
          logicalName,
          approval,
          promotionReadiness,
        },
      });
    }

    const requestedBy = getUserIdForRequest(req) ?? "operator";
    const request = createApprovalRequest(
      promotionWorkflowId(logicalName),
      `${PROMOTION_APPROVAL_WORKFLOW_PREFIX}:${logicalName}:${Date.now()}`,
      requestedBy,
      1,
      Date.now() + PROMOTION_APPROVAL_TTL_MS,
      getCurrentTenantContext(),
    );

    writeActionAudit({
      userId: getUserIdForRequest(req),
      actionKind: "models.promotion.request",
      reason,
      target: logicalName,
      targetType: "model",
      targetId: logicalName,
      risk: "high",
      request: {
        logicalName,
        gateBeforeRequest: promotionReadiness.gate,
        reasons: promotionReadiness.reasons,
        threshold: promotionReadiness.threshold,
      },
      resultStatus: "success",
      resultJson: {
        approvalId: request.id,
        workflowId: request.workflowId,
        runId: request.runId,
        status: request.status,
      },
      evidence: [
        { label: "Model lifecycle", ref: `/api/models/${encodeURIComponent(logicalName)}/lifecycle` },
        { label: "Approval request", ref: `governance_approvals:${request.id}` },
      ],
      rollbackHint: "Reject or expire the approval request before promotion is applied.",
    });

    const nextReadiness = computePromotionReadiness({
      evalHistory: evals.history,
      qualityStatus: quality.qualityStatus,
      recentFailures: quality.recentFailures,
      consecutiveGarbage: quality.consecutiveGarbage,
      approval: request,
    });

    return Response.json({
      data: {
        logicalName,
        approval: request,
        promotionReadiness: nextReadiness,
      },
    }, { status: 201 });
  } catch (e) {
    console.error("modelPromotionRequestHandler failed:", e);
    return Response.json({ error: "Failed to request model promotion approval" }, { status: 500 });
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
