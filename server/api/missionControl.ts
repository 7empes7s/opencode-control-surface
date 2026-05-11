import { readFileSync } from "node:fs";
import { buildHomeData } from "./home.ts";
import type { AutopipelineWidget, DoctorWidget, ModelsWidget, IncidentsWidget } from "./types.ts";
import { readOperatorState, writeOperatorState } from "../db/writer.ts";
import { isDashboardDbEnabled } from "../db/dashboard.ts";

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

interface DecisionQueueItem {
  id: string;
  severity: "info" | "warn" | "critical";
  title: string;
  description: string;
  ageMs: number;
  action?: string;
  actionId?: string;
  sourceRoute?: string;
}

interface NextBestAction {
  id: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high";
  targetRoute?: string;
}

interface RiskStripItem {
  kind: "runway" | "stale_telemetry" | "failed_check" | "incident" | "disk" | "queue";
  label: string;
  severity: "ok" | "warn" | "critical";
  value?: string;
}

interface MissionControlData {
  nowCard: {
    posture: "ok" | "warn" | "critical";
    summary: string;
    sources: string[];
  };
  decisionQueue: DecisionQueueItem[];
  changeSinceLastVisit: {
    lastVisitTs: number | null;
    newArticles: number;
    queueDelta: number;
    newIncidents: number;
    modelsChanged: number;
    vastRunwayDeltaHours: number | null;
  } | null;
  nextBestActions: NextBestAction[];
  riskStrip: RiskStripItem[];
}

function computeNowCard(
  ap: AutopipelineWidget,
  gpuStatus: string,
  vastRunwayHours: number | null,
  doctor: DoctorWidget,
  incidentCount: number,
  publishedToday: number
): { posture: "ok" | "warn" | "critical"; summary: string; sources: string[] } {
  const signals: { priority: number; summary: string; severity: "ok" | "warn" | "critical" }[] = [];

  if (ap.paused && ap.queueDepth > 0) {
    signals.push({ priority: 1, summary: `Pipeline paused — ${ap.approvalsWaiting} approvals waiting`, severity: "warn" });
  }

  if (gpuStatus === "down") {
    signals.push({ priority: 2, summary: "GPU down — cloud fallback active", severity: "warn" });
  }

  if (vastRunwayHours !== null && vastRunwayHours < 12) {
    signals.push({ priority: 3, summary: `Vast runway critical: ${vastRunwayHours}h remaining`, severity: "critical" });
  }

  if (doctor.lastDecision) {
    const hoursSince = (Date.now() - new Date(doctor.lastDecision.ts).getTime()) / 3_600_000;
    if (hoursSince <= 24) {
      const failed = doctor.last24h.total - doctor.last24h.success;
      if (failed > 2) {
        signals.push({ priority: 4, summary: `Doctor abandoned ${failed} publish jobs in 24h`, severity: "warn" });
      }
    }
  }

  if (incidentCount > 0) {
    signals.push({ priority: 5, summary: `${incidentCount} incidents open`, severity: "warn" });
  }

  signals.sort((a, b) => a.priority - b.priority);
  const worst = signals[0];
  if (worst) {
    return { posture: worst.severity, summary: worst.summary, sources: signals.map(s => s.summary) };
  }
  return { posture: "ok", summary: `Stack healthy — ${publishedToday} articles published today`, sources: [] };
}

function computeDecisionQueue(
  ap: AutopipelineWidget,
  gpuStatus: string,
  vastRunwayHours: number | null,
  incidents: IncidentsWidget["recentAlerts"]
): DecisionQueueItem[] {
  const items: DecisionQueueItem[] = [];
  const now = Date.now();

  if (ap.approvalsWaiting > 10) {
    const severity = ap.approvalsWaiting > 50 ? "critical" : "warn";
    items.push({
      id: "approvals-waiting",
      severity,
      title: `${ap.approvalsWaiting} stories waiting for approval`,
      description: severity === "critical" ? "Critical backlog - immediate action needed" : "Review and approve pending stories",
      ageMs: ap.oldestApprovalAgeMs ?? 0,
      action: "Review queue",
      sourceRoute: "/autopipeline",
    });
  }

  if (ap.paused && ap.queueDepth > 0) {
    items.push({
      id: "pipeline-paused",
      severity: "warn",
      title: `Pipeline paused with ${ap.queueDepth} items queued`,
      description: ap.pauseReason ?? "Pipeline is paused",
      ageMs: now,
      action: "Resume pipeline",
      sourceRoute: "/autopipeline",
    });
  }

  if (gpuStatus === "down") {
    items.push({
      id: "gpu-offline",
      severity: "critical",
      title: "GPU offline — check Vast tunnel",
      description: "Local GPU is not accessible, using cloud fallbacks",
      ageMs: now,
      action: "Check GPU health",
      sourceRoute: "/infra",
    });
  }

  if (vastRunwayHours !== null && vastRunwayHours < 24) {
    items.push({
      id: "vast-runway-low",
      severity: vastRunwayHours < 12 ? "critical" : "warn",
      title: `Vast runway low: ${vastRunwayHours}h`,
      description: "Consider adding funds to Vast account",
      ageMs: now,
      action: "Check Vast",
      sourceRoute: "/infra",
    });
  }

  for (let i = 0; i < Math.min(incidents.length, 5); i++) {
    const inc = incidents[i];
    items.push({
      id: `incident-${inc.key}`,
      severity: "warn",
      title: `Incident: ${inc.key}`,
      description: "Review and resolve incident",
      ageMs: now - inc.ts,
      action: "Review incident",
      sourceRoute: "/incidents",
    });
  }

  return items;
}

function computeNextBestActions(
  ap: AutopipelineWidget,
  gpuStatus: string,
  models: ModelsWidget,
  incidentCount: number
): NextBestAction[] {
  const actions: NextBestAction[] = [];

  if (ap.approvalsWaiting > 0) {
    actions.push({
      id: "approve-pending",
      label: "Approve pending stories",
      description: `${ap.approvalsWaiting} stories awaiting approval`,
      risk: "low",
      targetRoute: "/autopipeline",
    });
  }

  if (ap.paused) {
    actions.push({
      id: "resume-pipeline",
      label: "Resume pipeline",
      description: "Get the autopipeline running again",
      risk: "medium",
      targetRoute: "/autopipeline",
    });
  }

  if (gpuStatus === "down") {
    actions.push({
      id: "check-gpu",
      label: "Check GPU health",
      description: "GPU is down - investigate Vast tunnel",
      risk: "medium",
      targetRoute: "/infra",
    });
  }

  if (models.qualitySummary.blocked > 0 || models.qualitySummary.probation > 0) {
    actions.push({
      id: "review-models",
      label: "Review model health",
      description: `${models.qualitySummary.blocked} blocked, ${models.qualitySummary.probation} on probation`,
      risk: "low",
      targetRoute: "/models",
    });
  }

  if (incidentCount > 0) {
    actions.push({
      id: "review-incidents",
      label: "Review incidents",
      description: `${incidentCount} open incidents`,
      risk: "medium",
      targetRoute: "/incidents",
    });
  }

  return actions.slice(0, 4);
}

function computeRiskStrip(
  vastRunwayHours: number | null,
  allSourcesOk: boolean,
  doctor: DoctorWidget,
  incidentCount: number,
  ap: AutopipelineWidget
): RiskStripItem[] {
  const items: RiskStripItem[] = [];

  if (vastRunwayHours === null) {
    items.push({ kind: "runway", label: "runway", severity: "ok", value: "unknown" });
  } else if (vastRunwayHours > 24) {
    items.push({ kind: "runway", label: "runway", severity: "ok", value: `${vastRunwayHours}h` });
  } else if (vastRunwayHours >= 12) {
    items.push({ kind: "runway", label: "runway", severity: "warn", value: `${vastRunwayHours}h` });
  } else {
    items.push({ kind: "runway", label: "runway", severity: "critical", value: `${vastRunwayHours}h` });
  }

  items.push({ kind: "stale_telemetry", label: "telemetry", severity: allSourcesOk ? "ok" : "warn" });

  if (doctor.last24h.total > 0) {
    const rate = doctor.last24h.success / doctor.last24h.total;
    items.push({
      kind: "failed_check",
      label: "doctor",
      severity: rate >= 0.9 ? "ok" : rate >= 0.6 ? "warn" : "critical",
      value: `${Math.round(rate * 100)}%`,
    });
  } else {
    items.push({ kind: "failed_check", label: "doctor", severity: "ok" });
  }

  items.push({
    kind: "incident",
    label: "incidents",
    severity: incidentCount === 0 ? "ok" : incidentCount <= 2 ? "warn" : "critical",
    value: incidentCount > 0 ? `${incidentCount}` : undefined,
  });

  if (ap.approvalsWaiting > 50) {
    items.push({ kind: "queue", label: "queue", severity: "warn", value: `${ap.approvalsWaiting} pending` });
  } else if (ap.paused && ap.queueDepth > 0) {
    items.push({ kind: "queue", label: "queue", severity: "warn", value: "paused" });
  } else {
    items.push({ kind: "queue", label: "queue", severity: "ok", value: `${ap.queueDepth}` });
  }

  return items;
}

export async function missionControlHandler(): Promise<Response> {
  const dbEnabled = isDashboardDbEnabled();

  // Single shared fetch — reuses the same adapter calls as /api/home
  let homeResult: { data: import("./types.ts").HomeData; sources: Record<string, import("./types.ts").SourceStatus> };
  try {
    homeResult = await buildHomeData();
  } catch {
    return new Response(JSON.stringify({ error: "failed to build home data" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data, sources } = homeResult;
  const allSourcesOk = Object.values(sources).every(s => s === "ok");

  const gpuStatus = data.gpu.status;
  const vastRunwayHours = data.vast.runwayHours;
  const incidentCount = data.incidents.activeCount;
  const incidents = data.incidents.recentAlerts;

  const nowCard = computeNowCard(data.autopipeline, gpuStatus, vastRunwayHours, data.doctor, incidentCount, data.newsbites.publishedToday);
  const decisionQueue = computeDecisionQueue(data.autopipeline, gpuStatus, vastRunwayHours, incidents);
  const nextBestActions = computeNextBestActions(data.autopipeline, gpuStatus, data.models, incidentCount);
  const riskStrip = computeRiskStrip(vastRunwayHours, allSourcesOk, data.doctor, incidentCount, data.autopipeline);

  // Change since last visit (DB-backed)
  let changeSinceLastVisit: MissionControlData["changeSinceLastVisit"] = null;

  if (dbEnabled) {
    const lastVisitTs = readOperatorState("last_visit_ts") as number | null;
    const previousArticleCount = readOperatorState("snapshot.newsbites.articleCount") as number | null;
    const previousQueueDepth = readOperatorState("snapshot.queueDepth") as number | null;

    const currentArticleCount = data.newsbites.totalPublished;
    const currentQueueDepth = data.autopipeline.queueDepth;

    let newIncidents = 0;
    if (lastVisitTs) {
      try {
        const { getDashboardDb } = await import("../db/dashboard.ts");
        const db = getDashboardDb();
        if (db) {
          const result = db.query(
            "SELECT COUNT(*) as cnt FROM events WHERE status = 'open' AND ts > ?"
          ).get(lastVisitTs) as { cnt: number } | null;
          newIncidents = result?.cnt ?? 0;
        }
      } catch {}
    }

    const previousModelsCheck = readOperatorState("snapshot.modelsCheckAt") as number | null;
    const modelsCheckAt = data.models.lastFullCheckAgo > 0 ? Date.now() - data.models.lastFullCheckAgo : null;
    const modelsChanged = (modelsCheckAt && previousModelsCheck && modelsCheckAt > previousModelsCheck) ? 1 : 0;

    const previousRunway = readOperatorState("snapshot.vastRunwayHours") as number | null;
    const vastRunwayDelta = (previousRunway !== null && vastRunwayHours !== null)
      ? Math.round(vastRunwayHours - previousRunway)
      : null;

    changeSinceLastVisit = {
      lastVisitTs,
      newArticles: previousArticleCount !== null ? currentArticleCount - previousArticleCount : 0,
      queueDelta: previousQueueDepth !== null ? currentQueueDepth - previousQueueDepth : 0,
      newIncidents,
      modelsChanged,
      vastRunwayDeltaHours: vastRunwayDelta,
    };

    writeOperatorState("last_visit_ts", Date.now());
    writeOperatorState("snapshot.newsbites.articleCount", currentArticleCount);
    writeOperatorState("snapshot.queueDepth", currentQueueDepth);
    if (modelsCheckAt) writeOperatorState("snapshot.modelsCheckAt", modelsCheckAt);
    if (vastRunwayHours !== null) writeOperatorState("snapshot.vastRunwayHours", vastRunwayHours);
  }

  const result: MissionControlData = { nowCard, decisionQueue, changeSinceLastVisit, nextBestActions, riskStrip };
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}
