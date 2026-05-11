import type { HomeData, ServicePill } from "../api/types.ts";
import { isDashboardDbEnabled } from "./dashboard.ts";
import { writeEvent, writeMetricSample } from "./writer.ts";

export type PrevSnapshot = {
  services: Record<string, string>;
  gpuStatus: "up" | "down" | "unknown" | null;
  vastRunwayBucket: "ok" | "warn-24h" | "crit-6h" | null;
  modelsBucket: "healthy" | "degraded" | "down" | null;
  diskBucket: "ok" | "warn-70" | "crit-85" | null;
  queueHealthBucket: "ok" | "approval-warn" | "approval-critical" | "paused-with-queue" | "queue-large" | null;
  doctorDecisionKey: string | null;
  doctorRateLimitCount: number;
  doctorQuotaCount: number;
};

let prevSnapshot: PrevSnapshot | null = null;

type Severity = "info" | "warn" | "error";

function logMetricError(metric: string, error: unknown): void {
  console.error(`[sampler] ${metric} failed`, error);
}

function sampleMetric(source: string, key: string, value: unknown): void {
  try {
    writeMetricSample({ source, key, value });
  } catch (error) {
    logMetricError(`${source}.${key}`, error);
  }
}

function getServiceExitedAt(service: ServicePill): unknown {
  return (service as ServicePill & { exitedAt?: unknown }).exitedAt ?? null;
}

function sumValues(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function getOldestApprovalAgeMs(home: HomeData): number | null {
  if (typeof home.autopipeline.oldestApprovalAgeMs === "number") {
    return home.autopipeline.oldestApprovalAgeMs;
  }

  const maybeCreatedAt = (home.autopipeline as typeof home.autopipeline & {
    oldestApprovalCreatedAt?: unknown;
  }).oldestApprovalCreatedAt;

  if (typeof maybeCreatedAt === "number") {
    return Date.now() - maybeCreatedAt;
  }

  return null;
}

function getModelCounts(home: HomeData): { healthy: number; degraded: number; down: number } {
  const quality = home.models.qualitySummary;
  return {
    healthy: sumValues(home.models.availableByCapability),
    degraded: quality.degraded + quality.probation,
    down: quality.blocked,
  };
}

function getVastRunwayBucket(home: HomeData): PrevSnapshot["vastRunwayBucket"] {
  const runway = home.vast.runwayHours;
  if (typeof runway !== "number") {
    return null;
  }
  if (runway < 6) {
    return "crit-6h";
  }
  if (runway < 24) {
    return "warn-24h";
  }
  return "ok";
}

function getModelsBucket(home: HomeData): PrevSnapshot["modelsBucket"] {
  const counts = getModelCounts(home);
  if (counts.down > 0) {
    return "down";
  }
  if (counts.degraded > 0) {
    return "degraded";
  }
  return "healthy";
}

function getDiskBucket(home: HomeData): PrevSnapshot["diskBucket"] {
  const diskUsedPct = home.hetzner.diskUsedPct;
  if (typeof diskUsedPct !== "number" || diskUsedPct <= 0 || !Number.isFinite(diskUsedPct)) {
    return null;
  }
  if (diskUsedPct >= 85) {
    return "crit-85";
  }
  if (diskUsedPct >= 70) {
    return "warn-70";
  }
  return "ok";
}

function getQueueHealthBucket(home: HomeData): PrevSnapshot["queueHealthBucket"] {
  const approvalsWaiting = home.autopipeline.approvalsWaiting;
  const queueDepth = home.autopipeline.queueDepth;
  const oldestApprovalAgeMs = getOldestApprovalAgeMs(home);

  if (home.autopipeline.paused && queueDepth > 0) {
    return "paused-with-queue";
  }
  if (approvalsWaiting >= 50 || (oldestApprovalAgeMs !== null && oldestApprovalAgeMs >= 6 * 60 * 60 * 1000)) {
    return "approval-critical";
  }
  if (approvalsWaiting >= 10 || (oldestApprovalAgeMs !== null && oldestApprovalAgeMs >= 60 * 60 * 1000)) {
    return "approval-warn";
  }
  if (queueDepth >= 100) {
    return "queue-large";
  }
  return "ok";
}

function getDoctorDecisionKey(home: HomeData): string | null {
  const decision = home.doctor.lastDecision;
  if (!decision) {
    return null;
  }
  return `${decision.ts}|${decision.slug}|${decision.action}`;
}

function getDoctorErrorCount(home: HomeData, predicate: (type: string) => boolean): number {
  return home.doctor.last24h.errorClasses.reduce((total, entry) => {
    const type = entry.type.toLowerCase();
    return predicate(type) ? total + entry.count : total;
  }, 0);
}

function getDoctorRateLimitCount(home: HomeData): number {
  return getDoctorErrorCount(home, (type) => (
    type.includes("rate") ||
    type.includes("429") ||
    type.includes("ratelimit")
  ));
}

function getDoctorQuotaCount(home: HomeData): number {
  return getDoctorErrorCount(home, (type) => (
    type.includes("quota") ||
    type.includes("billing") ||
    type.includes("spending")
  ));
}

function serviceSeverity(state: string): Severity {
  if (state === "active") {
    return "info";
  }
  if (state === "failed") {
    return "error";
  }
  return "warn";
}

function gpuSeverity(status: PrevSnapshot["gpuStatus"]): Severity {
  if (status === "down") {
    return "error";
  }
  if (status === "unknown") {
    return "warn";
  }
  return "info";
}

function vastSeverity(bucket: PrevSnapshot["vastRunwayBucket"]): Severity {
  if (bucket === "crit-6h") {
    return "error";
  }
  if (bucket === "warn-24h") {
    return "warn";
  }
  return "info";
}

function modelsSeverity(bucket: PrevSnapshot["modelsBucket"]): Severity {
  if (bucket === "down") {
    return "error";
  }
  if (bucket === "degraded") {
    return "warn";
  }
  return "info";
}

function diskSeverity(bucket: PrevSnapshot["diskBucket"]): Severity {
  if (bucket === "crit-85") {
    return "error";
  }
  if (bucket === "warn-70") {
    return "warn";
  }
  return "info";
}

function queueHealthSeverity(bucket: PrevSnapshot["queueHealthBucket"]): Severity {
  if (bucket === "approval-critical" || bucket === "paused-with-queue") {
    return "error";
  }
  if (bucket === "approval-warn" || bucket === "queue-large") {
    return "warn";
  }
  return "info";
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) {
    return "unknown age";
  }
  const hours = ageMs / (60 * 60 * 1000);
  if (hours >= 1) {
    return `${Math.round(hours * 10) / 10}h`;
  }
  return `${Math.round(ageMs / 60000)}m`;
}

function doctorDecisionSeverity(action: string): Severity {
  if (action === "kill" || action === "abandon" || action === "failed") {
    return "error";
  }
  if (action === "retry" || action === "retry_escalate" || action === "cooldown") {
    return "warn";
  }
  return "info";
}

function snapshotHome(home: HomeData): PrevSnapshot {
  return {
    services: Object.fromEntries(home.services.map((service) => [service.name, service.status])),
    gpuStatus: home.gpu.status,
    vastRunwayBucket: getVastRunwayBucket(home),
    modelsBucket: getModelsBucket(home),
    diskBucket: getDiskBucket(home),
    queueHealthBucket: getQueueHealthBucket(home),
    doctorDecisionKey: getDoctorDecisionKey(home),
    doctorRateLimitCount: getDoctorRateLimitCount(home),
    doctorQuotaCount: getDoctorQuotaCount(home),
  };
}

function dedupeKey(entityType: string, entityId: string, newState: string): string {
  const minuteBucket = Math.floor(Date.now() / 60000);
  return `${entityType}:${entityId}:${newState}:${minuteBucket}`;
}

export function sampleHomeMetrics(home: HomeData): void {
  for (const service of home.services) {
    sampleMetric("services", `${service.name}.state`, {
      state: service.status,
      exitedAt: getServiceExitedAt(service),
    });
  }

  sampleMetric("gpu", "status", {
    status: home.gpu.status,
    util: home.gpu.gpuUtil,
    probeMs: home.gpu.probeMs,
    checkedAgo: home.gpu.checkedAgo,
  });

  sampleMetric("vast", "runway", {
    runwayHours: home.vast.runwayHours,
    hourlyRate: home.vast.hourlyRate,
    balance: home.vast.balance,
    credit: home.vast.credit,
    instanceStatus: home.vast.instanceStatus,
  });

  sampleMetric("hetzner", "load", {
    load1: home.hetzner.load1,
    load5: home.hetzner.load5,
    memUsedPct: home.hetzner.memUsedPct,
    diskUsedPct: home.hetzner.diskUsedPct,
  });

  sampleMetric("pipeline", "queue", {
    stageBreakdown: home.autopipeline.stageBreakdown,
    total: sumValues(home.autopipeline.stageBreakdown),
    oldestApprovalAgeMs: getOldestApprovalAgeMs(home),
  });

  sampleMetric("models", "health", getModelCounts(home));

  sampleMetric("newsbites", "published", {
    totalPublished: home.newsbites.totalPublished,
    publishedToday: home.newsbites.publishedToday,
  });

  sampleMetric("doctor", "decisions", {
    total24h: home.doctor.last24h.total,
    success24h: home.doctor.last24h.success,
    rateLimit24h: getDoctorRateLimitCount(home),
    quota24h: getDoctorQuotaCount(home),
    topFailingStages: home.doctor.last24h.topFailingStages,
    verdictMix: home.doctor.last24h.verdictMix,
    lastDecision: home.doctor.lastDecision,
  });
}

export function detectHomeTransitions(home: HomeData, prev: PrevSnapshot | null): PrevSnapshot {
  const next = snapshotHome(home);
  if (!prev) {
    return next;
  }

  for (const [name, newState] of Object.entries(next.services)) {
    const oldState = prev.services[name];
    if (!oldState || oldState === newState) {
      continue;
    }

    try {
      writeEvent({
        kind: "service.state",
        severity: serviceSeverity(newState),
        entityType: "service",
        entityId: name,
        summary: `${name}: ${oldState} → ${newState}`,
        payload: { previous: oldState, current: newState },
        dedupeKey: dedupeKey("service", name, newState),
      });
    } catch (error) {
      console.error("[sampler] service.state failed", error);
    }
  }

  if (prev.gpuStatus !== next.gpuStatus) {
    try {
      writeEvent({
        kind: "gpu.status",
        severity: gpuSeverity(next.gpuStatus),
        entityType: "gpu",
        entityId: "vast",
        summary: `GPU: ${prev.gpuStatus ?? "unknown"} → ${next.gpuStatus ?? "unknown"}`,
        payload: { previous: prev.gpuStatus, current: next.gpuStatus },
        dedupeKey: dedupeKey("gpu", "vast", next.gpuStatus ?? "unknown"),
      });
    } catch (error) {
      console.error("[sampler] gpu.status failed", error);
    }
  }

  if (prev.vastRunwayBucket !== next.vastRunwayBucket) {
    try {
      const current = next.vastRunwayBucket ?? "unknown";
      writeEvent({
        kind: "vast.runway",
        severity: vastSeverity(next.vastRunwayBucket),
        entityType: "vast",
        entityId: "runway",
        summary: `Vast runway: ${prev.vastRunwayBucket ?? "unknown"} → ${current}`,
        payload: { previous: prev.vastRunwayBucket, current, runwayHours: home.vast.runwayHours },
        dedupeKey: dedupeKey("vast", "runway", current),
      });
    } catch (error) {
      console.error("[sampler] vast.runway failed", error);
    }
  }

  if (prev.modelsBucket !== next.modelsBucket) {
    try {
      const current = next.modelsBucket ?? "unknown";
      writeEvent({
        kind: "models.health",
        severity: modelsSeverity(next.modelsBucket),
        entityType: "models",
        entityId: "health",
        summary: `Models: ${prev.modelsBucket ?? "unknown"} → ${current}`,
        payload: { previous: prev.modelsBucket, current, counts: getModelCounts(home) },
        dedupeKey: dedupeKey("models", "health", current),
      });
    } catch (error) {
      console.error("[sampler] models.health failed", error);
    }
  }

  if (prev.diskBucket !== null && next.diskBucket !== null && prev.diskBucket !== next.diskBucket) {
    try {
      writeEvent({
        kind: "disk.bucket",
        severity: diskSeverity(next.diskBucket),
        entityType: "hetzner",
        entityId: "disk",
        summary: `Disk: ${prev.diskBucket} → ${next.diskBucket} (${home.hetzner.diskUsedPct}%)`,
        payload: { previous: prev.diskBucket, current: next.diskBucket, diskUsedPct: home.hetzner.diskUsedPct },
        dedupeKey: dedupeKey("hetzner", "disk", next.diskBucket),
      });
    } catch (error) {
      console.error("[sampler] disk.bucket failed", error);
    }
  }

  if (prev.queueHealthBucket !== null && next.queueHealthBucket !== null && prev.queueHealthBucket !== next.queueHealthBucket) {
    try {
      const oldestApprovalAgeMs = getOldestApprovalAgeMs(home);
      writeEvent({
        kind: "pipeline.queue_health",
        severity: queueHealthSeverity(next.queueHealthBucket),
        entityType: "pipeline",
        entityId: "queue",
        summary: `Pipeline queue health: ${prev.queueHealthBucket} → ${next.queueHealthBucket} (${home.autopipeline.queueDepth} queued, ${home.autopipeline.approvalsWaiting} approvals, oldest ${formatAge(oldestApprovalAgeMs)})`,
        payload: {
          previous: prev.queueHealthBucket,
          current: next.queueHealthBucket,
          queueDepth: home.autopipeline.queueDepth,
          approvalsWaiting: home.autopipeline.approvalsWaiting,
          oldestApprovalAgeMs,
          paused: home.autopipeline.paused,
          pauseReason: home.autopipeline.pauseReason,
          stageBreakdown: home.autopipeline.stageBreakdown,
          currentStory: home.autopipeline.currentStory,
        },
        dedupeKey: dedupeKey("pipeline", "queue_health", next.queueHealthBucket),
      });
    } catch (error) {
      console.error("[sampler] pipeline.queue_health failed", error);
    }
  }

  if (prev.doctorDecisionKey !== null && next.doctorDecisionKey !== null && prev.doctorDecisionKey !== next.doctorDecisionKey) {
    try {
      const decision = home.doctor.lastDecision;
      if (decision) {
        writeEvent({
          kind: "doctor.decision",
          severity: doctorDecisionSeverity(decision.action),
          entityType: "doctor",
          entityId: decision.slug || "unknown",
          summary: `Doctor ${decision.action || "decision"}: ${decision.slug || "unknown"}`,
          payload: { previous: prev.doctorDecisionKey, current: next.doctorDecisionKey, decision },
          dedupeKey: dedupeKey("doctor", `${decision.slug || "unknown"}:${decision.action || "decision"}`, "decision"),
        });
      }
    } catch (error) {
      console.error("[sampler] doctor.decision failed", error);
    }
  }

  if (next.doctorRateLimitCount > prev.doctorRateLimitCount) {
    try {
      writeEvent({
        kind: "doctor.rate_limit",
        severity: "warn",
        entityType: "doctor",
        entityId: "rate_limit",
        summary: `Doctor rate-limit signals: ${prev.doctorRateLimitCount} → ${next.doctorRateLimitCount} in 24h`,
        payload: { previous: prev.doctorRateLimitCount, current: next.doctorRateLimitCount },
        dedupeKey: dedupeKey("doctor", "rate_limit", "increasing"),
      });
    } catch (error) {
      console.error("[sampler] doctor.rate_limit failed", error);
    }
  }

  if (next.doctorQuotaCount > prev.doctorQuotaCount) {
    try {
      writeEvent({
        kind: "doctor.quota",
        severity: "error",
        entityType: "doctor",
        entityId: "quota",
        summary: `Doctor quota signals: ${prev.doctorQuotaCount} → ${next.doctorQuotaCount} in 24h`,
        payload: { previous: prev.doctorQuotaCount, current: next.doctorQuotaCount },
        dedupeKey: dedupeKey("doctor", "quota", "increasing"),
      });
    } catch (error) {
      console.error("[sampler] doctor.quota failed", error);
    }
  }

  return next;
}

export function runHomeSampler(home: HomeData): void {
  if (!isDashboardDbEnabled()) return;
  try { sampleHomeMetrics(home); } catch (e) { console.error("[sampler] sampleHomeMetrics failed", e); }
  try { prevSnapshot = detectHomeTransitions(home, prevSnapshot); } catch (e) { console.error("[sampler] detectHomeTransitions failed", e); }
}

export function __resetSamplerStateForTests(): void {
  prevSnapshot = null;
}
