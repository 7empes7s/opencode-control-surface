import { buildHomeData } from "./home.ts";
import { isDashboardDbEnabled, getDashboardDb } from "../db/dashboard.ts";
import { readOperatorState, writeOperatorState } from "../db/writer.ts";

interface TodayData {
  date: string;
  overnightSummary: {
    eventsCount: number;
    topEvents: Array<{ title: string; severity: string; source: string }>;
    newArticles: number;
    serviceRestarts: number;
  };
  publishingSummary: {
    publishedToday: number;
    pendingApproval: number;
    failed: number;
    topCandidates: Array<{ slug: string; vertical: string; stage: string }>;
  };
  modelSummary: {
    bestAvailable: string[];
    degraded: string[];
    blocked: string[];
    newlyDiscovered: string[];
  };
  infraSummary: {
    gpuStatus: string;
    vastRunwayHours: number | null;
    serviceIssues: string[];
    recentRestarts: Array<{ name: string; restartedAt?: number }>;
  };
  costSummary: {
    vastBalanceUsd: number | null;
    estimatedDailyBurnUsd: number | null;
    projectedMonthlyUsd: number | null;
    note: string;
  };
  suggestedSchedule: Array<{
    order: number;
    task: string;
    reason: string;
    targetRoute?: string;
  }>;
}

export async function todayHandler(): Promise<Response> {
  const dbEnabled = isDashboardDbEnabled();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // Single shared fetch — same adapters as /api/home, no duplication
  let homeResult: { data: import("./types.ts").HomeData; sources: Record<string, import("./types.ts").SourceStatus> };
  try {
    homeResult = await buildHomeData();
  } catch {
    return new Response(JSON.stringify({ error: "failed to build home data" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data } = homeResult;

  // GPU status
  const gpuStatus = data.gpu.status;

  // Articles
  const publishedToday = data.newsbites.publishedToday;
  const totalPublished = data.newsbites.totalPublished;

  // Pipeline
  const pendingApproval = data.autopipeline.approvalsWaiting;
  const topCandidates = data.newsbites.latestArticles.slice(0, 3).map(a => ({
    slug: a.slug,
    vertical: a.vertical,
    stage: "published",
  }));

  // Models
  const bestAvailable: string[] = [];
  if (data.models.bestLocal) bestAvailable.push(data.models.bestLocal);
  if (data.models.bestCloudHeavy) bestAvailable.push(data.models.bestCloudHeavy);
  if (data.models.bestCloudFast) bestAvailable.push(data.models.bestCloudFast);
  const degradedCount = data.models.qualitySummary.degraded;
  const blockedCount = data.models.qualitySummary.blocked;
  const degraded = degradedCount > 0 ? Array(degradedCount).fill("degraded model") : [];
  const blocked = blockedCount > 0 ? Array(blockedCount).fill("blocked model") : [];
  const newlyDiscovered = data.models.newModelsAdded ?? [];

  // Vast / cost
  const vastBalanceUsd = (data.vast.balance ?? 0) + (data.vast.credit ?? 0);
  const hourlyRate = data.vast.hourlyRate;
  const estimatedDailyBurnUsd = hourlyRate !== null ? hourlyRate * 24 : null;
  const projectedMonthlyUsd = estimatedDailyBurnUsd !== null ? estimatedDailyBurnUsd * 30 : null;
  const vastRunwayHours = data.vast.runwayHours;

  // Service issues
  const serviceIssues = data.services
    .filter(s => s.status !== "active")
    .map(s => `${s.name}: ${s.status}`);

  // Events overnight (DB-backed)
  let eventsCount = 0;
  let topEvents: Array<{ title: string; severity: string; source: string }> = [];
  let newArticles = 0;
  let serviceRestarts = 0;

  if (dbEnabled) {
    const db = getDashboardDb();
    if (db) {
      try {
        const eventsResult = db.query("SELECT COUNT(*) as cnt FROM events WHERE ts >= ?").get(midnightUtc) as { cnt: number } | null;
        eventsCount = eventsResult?.cnt ?? 0;

        const events = db.query(
          "SELECT summary, severity, kind FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 5"
        ).all(midnightUtc) as Array<{ summary: string; severity: string; kind: string }>;
        topEvents = events.map(e => ({ title: e.summary, severity: e.severity, source: e.kind }));

        const restarts = db.query("SELECT COUNT(*) as cnt FROM events WHERE kind LIKE '%restart%' AND ts >= ?").get(midnightUtc) as { cnt: number } | null;
        serviceRestarts = restarts?.cnt ?? 0;
      } catch {}
    }

    const midnightKey = "snapshot.newsbites.articleCount.midnight";
    const snap = readOperatorState(midnightKey) as { date: string; count: number } | null;
    if (snap && snap.date === date) {
      newArticles = totalPublished - snap.count;
    } else {
      newArticles = publishedToday;
      writeOperatorState(midnightKey, { date, count: totalPublished });
    }
  } else {
    newArticles = publishedToday;
  }

  // Suggested schedule
  const suggestedSchedule: TodayData["suggestedSchedule"] = [];
  let order = 1;

  if (pendingApproval > 0) {
    suggestedSchedule.push({
      order: order++,
      task: `Clear approval backlog (${pendingApproval} stories)`,
      reason: "Stories are waiting for human review",
      targetRoute: "/autopipeline",
    });
  }

  if (data.autopipeline.paused) {
    suggestedSchedule.push({
      order: order++,
      task: "Resume pipeline",
      reason: "Autopipeline is currently paused",
      targetRoute: "/autopipeline",
    });
  }

  if (degradedCount > 0 || blockedCount > 0) {
    suggestedSchedule.push({
      order: order++,
      task: "Review model health",
      reason: `${degradedCount} degraded, ${blockedCount} blocked models need attention`,
      targetRoute: "/models",
    });
  }

  if (serviceIssues.length > 0) {
    suggestedSchedule.push({
      order: order++,
      task: "Review open incidents",
      reason: `${serviceIssues.length} services are not healthy`,
      targetRoute: "/incidents",
    });
  }

  if (suggestedSchedule.length === 0 && vastRunwayHours !== null) {
    suggestedSchedule.push({
      order: order++,
      task: "Check Vast runway",
      reason: `Current runway: ${vastRunwayHours}h — ensure sufficient balance`,
      targetRoute: "/infra",
    });
  }

  const result: TodayData = {
    date,
    overnightSummary: { eventsCount, topEvents, newArticles, serviceRestarts },
    publishingSummary: { publishedToday, pendingApproval, failed: 0, topCandidates },
    modelSummary: { bestAvailable, degraded, blocked, newlyDiscovered },
    infraSummary: { gpuStatus, vastRunwayHours, serviceIssues, recentRestarts: [] },
    costSummary: {
      vastBalanceUsd: vastBalanceUsd > 0 ? vastBalanceUsd : null,
      estimatedDailyBurnUsd,
      projectedMonthlyUsd,
      note: "Vast GPU only — cloud API costs not yet tracked.",
    },
    suggestedSchedule,
  };

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}
