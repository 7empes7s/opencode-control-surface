import { readFileSync } from "node:fs";
import { getServiceStatuses, getHetznerStats } from "../adapters/system.ts";
import { getPipelineState } from "../adapters/pipeline.ts";
import { getModelHealth } from "../adapters/models.ts";
import { getDoctorStats } from "../adapters/doctor.ts";
import { getArticles, buildNewsBitesWidget, isSiteReachable } from "../adapters/newsbites.ts";
import { getVastInstance, getVastAccount } from "../adapters/vast.ts";
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
  const [services, hetzner, pipeline, models, doctor, articles, siteUp, vastInst, vastAcct] =
    await Promise.all([
      settled(getServiceStatuses),
      settled(getHetznerStats),
      settled(getPipelineState),
      settled(getModelHealth),
      settled(getDoctorStats),
      settled(getArticles),
      settled(isSiteReachable),
      settled(getVastInstance),
      settled(getVastAccount),
    ]);

  sources.services = services.ok ? "ok" : "error";
  sources.hetzner = hetzner.ok ? "ok" : "error";
  sources.pipeline = pipeline.ok ? "ok" : "error";
  sources.models = models.ok ? "ok" : "error";
  sources.doctor = doctor.ok ? "ok" : "error";
  sources.newsbites = articles.ok ? "ok" : "error";
  sources.vast = (vastInst.ok && vastInst.value !== null) || (vastAcct.ok && vastAcct.value !== null) ? "ok" : "error";

  // ── GPU health (direct file read, fast) ────────────────────────────────
  const gpuRaw = readJson<{
    status?: string;
    gpu_max_util?: number;
    models?: string[];
    probe_ms?: number;
    checked_at?: number;
  }>("/var/lib/mimule/gpu-health.json");

  const gpuAgo = gpuRaw?.checked_at ? Date.now() - gpuRaw.checked_at * 1000 : Infinity;

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
  const vi = vastInst.ok ? vastInst.value : null;
  const va = vastAcct.ok ? vastAcct.value : null;
  const totalCredit = ((va?.balance ?? 0) + (va?.credit ?? 0));
  const hourly = vi?.hourlyRate ?? null;

  const data: HomeData = {
    services: services.ok ? services.value : [],

    gpu: {
      status: gpuRaw?.status === "up" ? "up" : gpuRaw?.status === "down" ? "down" : "unknown",
      gpuUtil: gpuRaw?.gpu_max_util ?? null,
      loadedModels: gpuRaw?.models ?? [],
      probeMs: gpuRaw?.probe_ms ?? null,
      checkedAgo: Math.round(gpuAgo / 1000),
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
  };

  return { data, sources };
}
