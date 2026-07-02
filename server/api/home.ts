import { readFileSync } from "node:fs";
import { getServiceStatuses, getHetznerStats } from "../adapters/system.ts";
import { getPipelineState } from "../adapters/pipeline.ts";
import { getModelHealth } from "../adapters/models.ts";
import { getDoctorStats } from "../adapters/doctor.ts";
import { getArticles, buildNewsBitesWidget, isSiteReachable } from "../adapters/newsbites.ts";
import { getVastInstanceState, getVastAccount } from "../adapters/vast.ts";
import { getOpenCodeSessionSummary } from "../adapters/opencode.ts";
import { runHomeSampler } from "../db/sampler.ts";
import { ok, type ApiEnvelope, type HomeData, type SourceStatus } from "./types.ts";

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

async function settled<T>(fn: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false }> {
  try { return { ok: true, value: await fn() }; }
  catch { return { ok: false }; }
}

type HomeBuildResult = { data: HomeData; sources: Record<string, SourceStatus> };

let cachedHome: { value: HomeBuildResult; ts: number } | null = null;
let homeBuildInFlight: Promise<HomeBuildResult> | null = null;
const HOME_CACHE_MS = 15_000;
// The vast-watchdog writes gpu-health.json every 60s when it is running; anything
// older than this is treated as "no current probe data", not as a live up/down signal.
const GPU_HEALTH_STALE_MS = Number(process.env.DASHBOARD_GPU_HEALTH_STALE_MS) || 15 * 60 * 1000;

type GpuStatusResult = { status: "up" | "down" | "off" | "unknown"; note: string | null };

/**
 * Honest GPU state: the GPU being off by operator choice (no Vast instance rented,
 * or instance stopped) must render as "off", never as a fake "down" failure built
 * from a stale probe file.
 */
export function deriveGpuStatus(input: {
  healthStatus: string | null;
  healthFresh: boolean;
  instanceKnown: boolean;
  instanceStatus: string | null; // null = no instance rented (when instanceKnown)
}): GpuStatusResult {
  const { healthStatus, healthFresh, instanceKnown, instanceStatus } = input;

  if (healthFresh && healthStatus === "up") {
    return { status: "up", note: null };
  }
  // Instance is running but the fresh probe says down → a real failure.
  if (healthFresh && healthStatus === "down" && instanceStatus === "running") {
    return { status: "down", note: "Vast instance is running but the GPU probe is failing — check the tunnel." };
  }
  if (instanceKnown && instanceStatus === null) {
    return { status: "off", note: "No Vast instance rented — GPU off by operator. Editorial runs on cloud models." };
  }
  if (instanceKnown && instanceStatus === "stopped") {
    return { status: "off", note: "Vast instance stopped — GPU off by operator. Editorial runs on cloud models." };
  }
  // Instance state unknown (CLI unavailable) — trust a fresh probe, otherwise be honest about not knowing.
  if (healthFresh && healthStatus === "down") {
    return { status: "down", note: null };
  }
  return {
    status: "unknown",
    note: healthStatus
      ? "GPU probe data is stale and the Vast instance state could not be read."
      : "No GPU probe data available.",
  };
}

export async function homeHandler(): Promise<Response> {
  const { data, sources } = await getHomeDataForRequest();
  try { runHomeSampler(data); } catch (e) { console.error("[home] sampler failed", e); }

  const envelope: ApiEnvelope<HomeData> = ok(data, sources);
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

async function getHomeDataForRequest(): Promise<HomeBuildResult> {
  if (cachedHome && Date.now() - cachedHome.ts < HOME_CACHE_MS) {
    return cachedHome.value;
  }
  if (cachedHome && homeBuildInFlight) {
    return {
      data: cachedHome.value.data,
      sources: { ...cachedHome.value.sources, cache: "stale" },
    };
  }
  return buildHomeData();
}

export async function buildHomeData(): Promise<HomeBuildResult> {
  if (homeBuildInFlight) return homeBuildInFlight;

  homeBuildInFlight = buildHomeDataUncached();
  try {
    const value = await homeBuildInFlight;
    cachedHome = { value, ts: Date.now() };
    return value;
  } finally {
    homeBuildInFlight = null;
  }
}

async function buildHomeDataUncached(): Promise<HomeBuildResult> {
  const sources: Record<string, SourceStatus> = {};

  // ── Parallel fetch all sources ──────────────────────────────────────────
  const [services, hetzner, pipeline, models, doctor, articles, siteUp, vastInst, vastAcct, opencode] =
    await Promise.all([
      settled(getServiceStatuses),
      settled(getHetznerStats),
      settled(getPipelineState),
      settled(getModelHealth),
      settled(getDoctorStats),
      settled(getArticles),
      settled(isSiteReachable),
      settled(getVastInstanceState),
      settled(getVastAccount),
      settled(getOpenCodeSessionSummary),
    ]);

  sources.services = services.ok ? "ok" : "error";
  sources.hetzner = hetzner.ok ? "ok" : "error";
  sources.pipeline = pipeline.ok ? "ok" : "error";
  sources.models = models.ok ? "ok" : "error";
  sources.doctor = doctor.ok ? "ok" : "error";
  sources.newsbites = articles.ok ? "ok" : "error";
  sources.vast = (vastInst.ok && vastInst.value.known) || (vastAcct.ok && vastAcct.value !== null) ? "ok" : "error";
  sources.opencode = opencode.ok && opencode.value.reachable ? "ok" : "error";

  // ── GPU health (direct file read, fast) ────────────────────────────────
  const gpuRaw = readJson<{
    status?: string;
    gpu_max_util?: number;
    models?: string[];
    probe_ms?: number;
    checked_at?: number;
  }>("/var/lib/mimule/gpu-health.json");

  const gpuAgo = gpuRaw?.checked_at ? Date.now() - gpuRaw.checked_at * 1000 : Infinity;
  const gpuHealthFresh = gpuAgo < GPU_HEALTH_STALE_MS;

  // ── Pipeline breakdown ─────────────────────────────────────────────────
  const pipeData = pipeline.ok ? pipeline.value : null;
  const stageBreakdown: Record<string, number> = {};
  const approvalsWaiting: { createdAt?: number }[] = [];
  if (pipeData) {
    for (const item of pipeData.queue) {
      stageBreakdown[item.stage] = (stageBreakdown[item.stage] ?? 0) + 1;
      if (item.waitingApproval) approvalsWaiting.push(item);
    }
  }
  const oldestApproval =
    approvalsWaiting.length > 0
      ? Math.min(...approvalsWaiting.map((a) => a.createdAt ?? Date.now()))
      : null;

  // ── Alerts ─────────────────────────────────────────────────────────────
  const alertsRaw = readJson<Record<string, number>>("/var/lib/mimule/pipeline-alerts.json") ?? {};
  const recentAlerts = Object.entries(alertsRaw)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, ts]) => ({ key, ts }));

  // ── NewsBites ──────────────────────────────────────────────────────────
  const nbWidget = articles.ok
    ? { ...buildNewsBitesWidget(articles.value), siteReachable: siteUp.ok ? siteUp.value : false }
    : { totalPublished: 0, publishedToday: 0, publishedLast7d: [], topVerticals: [], latestArticles: [], siteReachable: false };

  // ── Vast widget ────────────────────────────────────────────────────────
  const vastState = vastInst.ok ? vastInst.value : { known: false, instance: null };
  const vi = vastState.instance;
  const va = vastAcct.ok ? vastAcct.value : null;
  const totalCredit = ((va?.balance ?? 0) + (va?.credit ?? 0));
  const hourly = vi?.hourlyRate ?? null;

  const gpuDerived = deriveGpuStatus({
    healthStatus: gpuRaw?.status ?? null,
    healthFresh: gpuHealthFresh,
    instanceKnown: vastState.known,
    instanceStatus: vi?.status ?? null,
  });
  const gpuUtilRaw = gpuRaw?.gpu_max_util;

  const data: HomeData = {
    services: services.ok ? services.value : [],

    gpu: {
      status: gpuDerived.status,
      gpuUtil: gpuDerived.status === "up" && typeof gpuUtilRaw === "number" && gpuUtilRaw >= 0 ? gpuUtilRaw : null,
      loadedModels: gpuDerived.status === "up" ? gpuRaw?.models ?? [] : [],
      probeMs: gpuHealthFresh ? gpuRaw?.probe_ms ?? null : null,
      checkedAgo: Math.round(gpuAgo / 1000),
      note: gpuDerived.note,
    },

    vast: {
      balance: va?.balance ?? null,
      credit: va?.credit ?? null,
      hourlyRate: hourly,
      runwayHours: hourly && totalCredit > 0 ? Math.round((totalCredit / hourly) * 10) / 10 : null,
      instanceStatus: vi?.status ?? null,
      gpu: vi?.gpu ?? null,
    },

    hetzner: hetzner.ok
      ? {
          load1: hetzner.value.load1,
          load5: hetzner.value.load5,
          load15: hetzner.value.load15,
          memUsedPct: hetzner.value.memTotalKb > 0
            ? Math.round((hetzner.value.memUsedKb / hetzner.value.memTotalKb) * 100)
            : 0,
          diskUsedPct: hetzner.value.diskUsedPct,
        }
      : { load1: 0, load5: 0, load15: 0, memUsedPct: 0, diskUsedPct: 0 },

    newsbites: nbWidget,

    autopipeline: {
      queueDepth: pipeData?.queue.length ?? 0,
      approvalsWaiting: approvalsWaiting.length,
      oldestApprovalAgeMs: oldestApproval ? Date.now() - oldestApproval : null,
      currentStory: pipeData?.current ?? null,
      paused: pipeData?.paused ?? false,
      pauseReason: pipeData?.pauseReason ?? null,
      stageBreakdown,
    },

    doctor: doctor.ok
      ? {
          last24h: {
            total: doctor.value.total,
            success: doctor.value.success,
            errorClasses: doctor.value.errorClasses,
            topFailingModels: doctor.value.topFailingModels,
            topFailingStages: doctor.value.topFailingStages,
            verdictMix: doctor.value.verdictMix,
            rateLimitProviders: doctor.value.rateLimitProviders,
            fallbackCascades: doctor.value.fallbackCascades,
          },
          lastDecision: doctor.value.lastDecision,
        }
      : { last24h: { total: 0, success: 0, errorClasses: [], topFailingModels: [], topFailingStages: [], verdictMix: [] }, lastDecision: null },

    models: models.ok
      ? {
          bestLocal: models.value.bestLocal,
          bestCloudHeavy: models.value.bestCloudHeavy,
          bestCloudFast: models.value.bestCloudFast,
          availableByCapability: models.value.availableByCapability,
          qualitySummary: models.value.qualitySummary,
          newModelsAdded: models.value.newModelsAdded,
          lastFullCheckAgo: Math.round((Date.now() - models.value.lastFullCheckAt) / 1000),
          lastQuickCheckAgo: Math.round((Date.now() - models.value.lastQuickCheckAt) / 1000),
          cooldownsActive: models.value.cooldownsActive,
          soonestCooldownExpiresMs: models.value.soonestCooldownExpiresMs,
        }
      : {
          bestLocal: null, bestCloudHeavy: null, bestCloudFast: null,
          availableByCapability: { heavy: 0, medium: 0, light: 0 },
          qualitySummary: { blocked: 0, degraded: 0, probation: 0 },
          newModelsAdded: [], lastFullCheckAgo: 0, lastQuickCheckAgo: 0,
          cooldownsActive: 0, soonestCooldownExpiresMs: null,
        },

    incidents: {
      activeCount: recentAlerts.length,
      recentAlerts,
    },

    opencode: opencode.ok
      ? {
          reachable: opencode.value.reachable,
          sessionCount: opencode.value.sessionCount,
          active24h: opencode.value.active24h,
          latestUpdatedAt: opencode.value.latestUpdatedAt,
        }
      : { reachable: false, sessionCount: null, active24h: null, latestUpdatedAt: null },
  };

  return { data, sources };
}
