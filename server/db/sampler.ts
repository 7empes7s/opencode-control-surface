import { existsSync, readdirSync, statSync } from "node:fs";
import type { HomeData, ServicePill } from "../api/types.ts";
import { getDashboardDb, isDashboardDbEnabled } from "./dashboard.ts";
import { writeEvent, writeMetricSample } from "./writer.ts";

export type PrevSnapshot = {
  services: Record<string, string>;
  gpuStatus: "up" | "down" | "unknown" | null;
  vastRunwayBucket: "ok" | "warn-24h" | "crit-12h" | null;
  modelsBucket: "healthy" | "degraded" | "down" | null;
  diskBucket: "ok" | "warn-70" | "crit-85" | null;
  diskProjectionBucket: "ok" | "projected-90" | null;
  infraMemoryPressureBucket: "ok" | "pressure" | null;
  infraDiskPressureBucket: "ok" | "pressure" | null;
  infraRestartStormKey: string | null;
  infraTunnelFlappingKey: string | null;
  doctorLogBucket: "ok" | "large" | "huge" | null;
  backupFreshnessBucket: "fresh" | "stale" | "missing" | null;
  costBurnBucket: "ok" | "spike" | null;
  queueHealthBucket: "ok" | "approval-warn" | "approval-critical" | "paused-with-queue" | "queue-large" | "stage-concentration" | null;
  heavyTierBucket: "ok" | "exhausted" | null;
  providerRateLimitHotKey: string | null;
  fallbackCascadeKey: string | null;
  doctorDecisionKey: string | null;
  doctorRateLimitCount: number;
  doctorQuotaCount: number;
};

let prevSnapshot: PrevSnapshot | null = null;

type Severity = "info" | "warn" | "error";

type DiskProjection = {
  currentPct: number;
  dailyGrowthPct: number;
  projectedPct7d: number;
  daysTo90: number;
  sampleCount: number;
  oldestTs: number;
  newestTs: number;
};

type HetznerLoadSample = {
  ts: number;
  memUsedPct: number | null;
  diskUsedPct: number | null;
};

type InfraPressure = {
  currentPct: number;
  minPct: number;
  sampleCount: number;
  oldestTs: number;
  newestTs: number;
};

type ServiceRestartStorm = {
  service: string;
  restarts: number;
  sampleCount: number;
  windowMinutes: number;
  lastState: string;
};

type DoctorLogFinding = {
  path: string;
  sizeBytes: number;
  bucket: NonNullable<PrevSnapshot["doctorLogBucket"]>;
};

type BackupFreshness = {
  root: string;
  newestPath: string | null;
  newestMtimeMs: number | null;
  ageMs: number | null;
  bucket: NonNullable<PrevSnapshot["backupFreshnessBucket"]>;
};

type VastRunwaySample = {
  ts: number;
  hourlyRate: number | null;
  runwayHours: number | null;
  balance: number | null;
  credit: number | null;
};

type CostBurnSpike = {
  currentHourlyRate: number;
  baselineHourlyRate: number;
  multiplier: number;
  sampleCount: number;
  oldestTs: number;
  newestTs: number;
  runwayHours: number | null;
  balance: number | null;
  credit: number | null;
};

const DISK_PROJECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DISK_PROJECTION_MIN_SPAN_MS = 60 * 60 * 1000;
const COST_BURN_SPIKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const COST_BURN_SPIKE_MIN_SPAN_MS = 60 * 60 * 1000;
const MEMORY_PRESSURE_WINDOW_MS = 6 * 60 * 1000;
const MEMORY_PRESSURE_MIN_SPAN_MS = 5 * 60 * 1000;
const RESTART_STORM_WINDOW_MS = 60 * 60 * 1000;
const TUNNEL_FLAPPING_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_DOCTOR_LOG_WARN_BYTES = 50 * 1024 * 1024;
const DEFAULT_DOCTOR_LOG_CRIT_BYTES = 100 * 1024 * 1024;
const DEFAULT_BACKUP_STALE_MS = 25 * 60 * 60 * 1000;

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
  if (runway < 12) {
    return "crit-12h";
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

function getHeavyTierBucket(home: HomeData): PrevSnapshot["heavyTierBucket"] {
  const heavyCount = home.models.availableByCapability.heavy;
  if (typeof heavyCount !== "number" || !Number.isFinite(heavyCount)) {
    return null;
  }
  return heavyCount <= 0 ? "exhausted" : "ok";
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

function readHetznerLoadSample(ts: number, valueJson: string): HetznerLoadSample {
  try {
    const value = JSON.parse(valueJson) as { memUsedPct?: unknown; diskUsedPct?: unknown };
    const memUsedPct = typeof value.memUsedPct === "number" && Number.isFinite(value.memUsedPct) && value.memUsedPct > 0
      ? value.memUsedPct
      : null;
    const diskUsedPct = typeof value.diskUsedPct === "number" && Number.isFinite(value.diskUsedPct) && value.diskUsedPct > 0
      ? value.diskUsedPct
      : null;
    return { ts, memUsedPct, diskUsedPct };
  } catch {
    return { ts, memUsedPct: null, diskUsedPct: null };
  }
}

function getDiskProjection(): DiskProjection | null {
  const db = getDashboardDb();
  if (!db) {
    return null;
  }

  const rows = db.query(`
    SELECT ts, value_json
    FROM metric_samples
    WHERE source = ? AND key = ? AND ts >= ?
    ORDER BY ts ASC
    LIMIT 512
  `).all("hetzner", "load", Date.now() - DISK_PROJECTION_WINDOW_MS) as Array<{ ts: number; value_json: string }>;

  const samples = rows
    .map((row) => readHetznerLoadSample(row.ts, row.value_json))
    .filter((row): row is HetznerLoadSample & { diskUsedPct: number } => row.diskUsedPct !== null);

  if (samples.length < 2) {
    return null;
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanMs = last.ts - first.ts;
  if (spanMs < DISK_PROJECTION_MIN_SPAN_MS) {
    return null;
  }

  const spanDays = spanMs / (24 * 60 * 60 * 1000);
  const dailyGrowthPct = (last.diskUsedPct - first.diskUsedPct) / spanDays;
  if (!Number.isFinite(dailyGrowthPct) || dailyGrowthPct <= 0) {
    return {
      currentPct: last.diskUsedPct,
      dailyGrowthPct,
      projectedPct7d: last.diskUsedPct,
      daysTo90: Number.POSITIVE_INFINITY,
      sampleCount: samples.length,
      oldestTs: first.ts,
      newestTs: last.ts,
    };
  }

  return {
    currentPct: last.diskUsedPct,
    dailyGrowthPct,
    projectedPct7d: last.diskUsedPct + dailyGrowthPct * 7,
    daysTo90: (90 - last.diskUsedPct) / dailyGrowthPct,
    sampleCount: samples.length,
    oldestTs: first.ts,
    newestTs: last.ts,
  };
}

function getDiskProjectionBucket(projection: DiskProjection | null): PrevSnapshot["diskProjectionBucket"] {
  if (!projection || !Number.isFinite(projection.daysTo90)) {
    return projection ? "ok" : null;
  }
  if (projection.currentPct < 90 && projection.daysTo90 <= 7) {
    return "projected-90";
  }
  return "ok";
}

function getMemoryPressure(): InfraPressure | null {
  const db = getDashboardDb();
  if (!db) {
    return null;
  }

  const rows = db.query(`
    SELECT ts, value_json
    FROM metric_samples
    WHERE source = ? AND key = ? AND ts >= ?
    ORDER BY ts ASC
    LIMIT 32
  `).all("hetzner", "load", Date.now() - MEMORY_PRESSURE_WINDOW_MS) as Array<{ ts: number; value_json: string }>;

  const samples = rows
    .map((row) => readHetznerLoadSample(row.ts, row.value_json))
    .filter((row): row is HetznerLoadSample & { memUsedPct: number } => row.memUsedPct !== null);

  if (samples.length < 2) {
    return null;
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  if (last.ts - first.ts < MEMORY_PRESSURE_MIN_SPAN_MS) {
    return null;
  }

  const minPct = Math.min(...samples.map((sample) => sample.memUsedPct));
  if (minPct < 90) {
    return null;
  }

  return {
    currentPct: last.memUsedPct,
    minPct,
    sampleCount: samples.length,
    oldestTs: first.ts,
    newestTs: last.ts,
  };
}

function getMemoryPressureBucket(pressure: InfraPressure | null): PrevSnapshot["infraMemoryPressureBucket"] {
  return pressure ? "pressure" : "ok";
}

function readVastRunwaySample(ts: number, valueJson: string): VastRunwaySample {
  try {
    const value = JSON.parse(valueJson) as {
      hourlyRate?: unknown;
      runwayHours?: unknown;
      balance?: unknown;
      credit?: unknown;
    };
    const hourlyRate = typeof value.hourlyRate === "number" && Number.isFinite(value.hourlyRate) && value.hourlyRate > 0
      ? value.hourlyRate
      : null;
    const runwayHours = typeof value.runwayHours === "number" && Number.isFinite(value.runwayHours) && value.runwayHours >= 0
      ? value.runwayHours
      : null;
    const balance = typeof value.balance === "number" && Number.isFinite(value.balance) ? value.balance : null;
    const credit = typeof value.credit === "number" && Number.isFinite(value.credit) ? value.credit : null;
    return { ts, hourlyRate, runwayHours, balance, credit };
  } catch {
    return { ts, hourlyRate: null, runwayHours: null, balance: null, credit: null };
  }
}

function getCostBurnSpike(): CostBurnSpike | null {
  const db = getDashboardDb();
  if (!db) {
    return null;
  }

  const rows = db.query(`
    SELECT ts, value_json
    FROM metric_samples
    WHERE source = ? AND key = ? AND ts >= ?
    ORDER BY ts ASC
    LIMIT 256
  `).all("vast", "runway", Date.now() - COST_BURN_SPIKE_WINDOW_MS) as Array<{ ts: number; value_json: string }>;

  const samples = rows
    .map((row) => readVastRunwaySample(row.ts, row.value_json))
    .filter((row): row is VastRunwaySample & { hourlyRate: number } => row.hourlyRate !== null);

  if (samples.length < 2) {
    return null;
  }

  const first = samples[0];
  const current = samples[samples.length - 1];
  if (current.ts - first.ts < COST_BURN_SPIKE_MIN_SPAN_MS) {
    return null;
  }

  const previousSamples = samples.slice(0, -1);
  const baselineHourlyRate = previousSamples.reduce((sum, sample) => sum + sample.hourlyRate, 0) / previousSamples.length;
  const multiplier = baselineHourlyRate > 0 ? current.hourlyRate / baselineHourlyRate : 0;
  if (!Number.isFinite(multiplier) || multiplier < 2 || current.hourlyRate - baselineHourlyRate < 0.25) {
    return null;
  }

  return {
    currentHourlyRate: current.hourlyRate,
    baselineHourlyRate,
    multiplier,
    sampleCount: samples.length,
    oldestTs: first.ts,
    newestTs: current.ts,
    runwayHours: current.runwayHours,
    balance: current.balance,
    credit: current.credit,
  };
}

function getCostBurnBucket(spike: CostBurnSpike | null): PrevSnapshot["costBurnBucket"] {
  return spike ? "spike" : "ok";
}

function getInfraDiskPressureBucket(home: HomeData): PrevSnapshot["infraDiskPressureBucket"] {
  const diskUsedPct = home.hetzner.diskUsedPct;
  if (typeof diskUsedPct !== "number" || !Number.isFinite(diskUsedPct) || diskUsedPct <= 0) {
    return null;
  }
  return diskUsedPct >= 85 ? "pressure" : "ok";
}

function readServiceState(valueJson: string): string | null {
  try {
    const value = JSON.parse(valueJson) as { state?: unknown };
    return typeof value.state === "string" && value.state ? value.state : null;
  } catch {
    return null;
  }
}

function getServiceRestartStorms(windowMs: number, minRestarts: number, serviceFilter?: Set<string>): ServiceRestartStorm[] {
  const db = getDashboardDb();
  if (!db) {
    return [];
  }

  const rows = db.query(`
    SELECT ts, key, value_json
    FROM metric_samples
    WHERE source = ? AND key LIKE ? AND ts >= ?
    ORDER BY key ASC, ts ASC
    LIMIT 2048
  `).all("services", "%.state", Date.now() - windowMs) as Array<{ ts: number; key: string; value_json: string }>;

  const byService = new Map<string, string[]>();
  for (const row of rows) {
    const service = row.key.endsWith(".state") ? row.key.slice(0, -".state".length) : row.key;
    if (serviceFilter && !serviceFilter.has(service)) {
      continue;
    }
    const state = readServiceState(row.value_json);
    if (!state) {
      continue;
    }
    const states = byService.get(service) ?? [];
    states.push(state);
    byService.set(service, states);
  }

  const storms: ServiceRestartStorm[] = [];
  for (const [service, states] of byService.entries()) {
    let restarts = 0;
    for (let i = 1; i < states.length; i++) {
      if (states[i - 1] !== "active" && states[i] === "active") {
        restarts++;
      }
    }
    if (restarts >= minRestarts) {
      storms.push({
        service,
        restarts,
        sampleCount: states.length,
        windowMinutes: Math.round(windowMs / 60000),
        lastState: states[states.length - 1],
      });
    }
  }

  return storms.sort((a, b) => a.service.localeCompare(b.service));
}

function getRestartStormKey(storms: ServiceRestartStorm[]): string | null {
  if (storms.length === 0) {
    return null;
  }
  return storms.map((storm) => `${storm.service}:${storm.restarts}`).join("|");
}

function readNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getDoctorLogFinding(): DoctorLogFinding | null {
  const path = process.env.DASHBOARD_DOCTOR_LOG_PATH ?? "/var/lib/mimule/doctor-log.jsonl";
  if (!existsSync(path)) {
    return null;
  }

  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return null;
    }

    const warnBytes = readNumberEnv("DASHBOARD_DOCTOR_LOG_WARN_BYTES", DEFAULT_DOCTOR_LOG_WARN_BYTES);
    const critBytes = readNumberEnv("DASHBOARD_DOCTOR_LOG_CRIT_BYTES", DEFAULT_DOCTOR_LOG_CRIT_BYTES);
    const bucket = stat.size >= critBytes ? "huge" : stat.size >= warnBytes ? "large" : "ok";
    return { path, sizeBytes: stat.size, bucket };
  } catch {
    return null;
  }
}

function getBackupFreshness(): BackupFreshness | null {
  const root = process.env.DASHBOARD_BACKUP_ROOT ?? "/opt/backups";
  if (!existsSync(root)) {
    return null;
  }

  try {
    let newestPath: string | null = null;
    let newestMtimeMs: number | null = null;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const path = `${root}/${entry.name}`;
      const stat = statSync(path);
      if (!stat.isDirectory() && !stat.isFile()) {
        continue;
      }
      if (newestMtimeMs === null || stat.mtimeMs > newestMtimeMs) {
        newestMtimeMs = stat.mtimeMs;
        newestPath = path;
      }
    }

    if (newestMtimeMs === null) {
      return { root, newestPath: null, newestMtimeMs: null, ageMs: null, bucket: "missing" };
    }

    const ageMs = Date.now() - newestMtimeMs;
    const staleMs = readNumberEnv("DASHBOARD_BACKUP_STALE_MS", DEFAULT_BACKUP_STALE_MS);
    return {
      root,
      newestPath,
      newestMtimeMs,
      ageMs,
      bucket: ageMs > staleMs ? "stale" : "fresh",
    };
  } catch {
    return null;
  }
}

function getLargestPipelineStage(home: HomeData): { stage: string; count: number; pct: number } | null {
  const entries = Object.entries(home.autopipeline.stageBreakdown)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0 || home.autopipeline.queueDepth <= 0) {
    return null;
  }
  const [stage, count] = entries[0];
  return { stage, count, pct: count / home.autopipeline.queueDepth };
}

function getQueueHealthBucket(home: HomeData): PrevSnapshot["queueHealthBucket"] {
  const approvalsWaiting = home.autopipeline.approvalsWaiting;
  const queueDepth = home.autopipeline.queueDepth;
  const oldestApprovalAgeMs = getOldestApprovalAgeMs(home);
  const largestStage = getLargestPipelineStage(home);

  if (home.autopipeline.paused && queueDepth > 0) {
    return "paused-with-queue";
  }
  if (approvalsWaiting >= 50 || (oldestApprovalAgeMs !== null && oldestApprovalAgeMs >= 6 * 60 * 60 * 1000)) {
    return "approval-critical";
  }
  if (approvalsWaiting >= 10 || (oldestApprovalAgeMs !== null && oldestApprovalAgeMs >= 60 * 60 * 1000)) {
    return "approval-warn";
  }
  if (queueDepth >= 20 && largestStage && largestStage.pct >= 0.75) {
    return "stage-concentration";
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

function getProviderRateLimitHotKey(home: HomeData): string | null {
  const providers = home.doctor.last24h.rateLimitProviders ?? [];
  if (providers.length === 0) {
    return null;
  }
  return providers
    .map((signal) => signal.provider)
    .filter(Boolean)
    .sort()
    .join("|") || null;
}

function getFallbackCascadeKey(home: HomeData): string | null {
  const cascades = home.doctor.last24h.fallbackCascades ?? [];
  if (cascades.length === 0) {
    return null;
  }
  return cascades
    .map((signal) => `${signal.stage}:${signal.model}`)
    .filter(Boolean)
    .sort()
    .join("|") || null;
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
  if (bucket === "crit-12h") {
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

function heavyTierSeverity(bucket: PrevSnapshot["heavyTierBucket"]): Severity {
  return bucket === "exhausted" ? "error" : "info";
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

function diskProjectionSeverity(projection: DiskProjection): Severity {
  return projection.daysTo90 <= 2 ? "error" : "warn";
}

function doctorLogSeverity(finding: DoctorLogFinding): Severity {
  return finding.bucket === "huge" ? "error" : finding.bucket === "large" ? "warn" : "info";
}

function backupFreshnessSeverity(freshness: BackupFreshness): Severity {
  return freshness.bucket === "missing" ? "error" : freshness.bucket === "stale" ? "warn" : "info";
}

function infraMemoryPressureSeverity(pressure: InfraPressure): Severity {
  return pressure.currentPct >= 95 ? "error" : "warn";
}

function infraDiskPressureSeverity(diskUsedPct: number): Severity {
  return diskUsedPct >= 90 ? "error" : "warn";
}

function costBurnSpikeSeverity(spike: CostBurnSpike): Severity {
  return spike.multiplier >= 3 || (spike.runwayHours !== null && spike.runwayHours < 24) ? "error" : "warn";
}

function queueHealthSeverity(bucket: PrevSnapshot["queueHealthBucket"]): Severity {
  if (bucket === "approval-critical" || bucket === "paused-with-queue") {
    return "error";
  }
  if (bucket === "approval-warn" || bucket === "queue-large" || bucket === "stage-concentration") {
    return "warn";
  }
  return "info";
}

function queueHealthEventKind(bucket: PrevSnapshot["queueHealthBucket"]): string {
  if (bucket === "paused-with-queue") {
    return "queue.stuck";
  }
  if (bucket === "approval-warn" || bucket === "approval-critical") {
    return "queue.approval_backlog";
  }
  if (bucket === "queue-large" || bucket === "stage-concentration") {
    return "queue.stage_concentration";
  }
  return "queue.health";
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

function formatDays(days: number): string {
  if (!Number.isFinite(days)) {
    return "unknown";
  }
  if (days >= 1) {
    return `${Math.round(days * 10) / 10}d`;
  }
  return `${Math.max(Math.round(days * 24 * 10) / 10, 0)}h`;
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
  const diskProjection = getDiskProjection();
  const memoryPressure = getMemoryPressure();
  const costBurnSpike = getCostBurnSpike();
  const restartStorms = getServiceRestartStorms(RESTART_STORM_WINDOW_MS, 4);
  const tunnelFlapping = getServiceRestartStorms(TUNNEL_FLAPPING_WINDOW_MS, 3, new Set(["vast-tunnel"]));
  const doctorLog = getDoctorLogFinding();
  const backupFreshness = getBackupFreshness();
  return {
    services: Object.fromEntries(home.services.map((service) => [service.name, service.status])),
    gpuStatus: home.gpu.status,
    vastRunwayBucket: getVastRunwayBucket(home),
    modelsBucket: getModelsBucket(home),
    diskBucket: getDiskBucket(home),
    diskProjectionBucket: getDiskProjectionBucket(diskProjection),
    infraMemoryPressureBucket: getMemoryPressureBucket(memoryPressure),
    infraDiskPressureBucket: getInfraDiskPressureBucket(home),
    infraRestartStormKey: getRestartStormKey(restartStorms),
    infraTunnelFlappingKey: getRestartStormKey(tunnelFlapping),
    doctorLogBucket: doctorLog?.bucket ?? null,
    backupFreshnessBucket: backupFreshness?.bucket ?? null,
    costBurnBucket: getCostBurnBucket(costBurnSpike),
    queueHealthBucket: getQueueHealthBucket(home),
    heavyTierBucket: getHeavyTierBucket(home),
    providerRateLimitHotKey: getProviderRateLimitHotKey(home),
    fallbackCascadeKey: getFallbackCascadeKey(home),
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
  sampleMetric("models", "provider_pressure", {
    rateLimitProviders: home.doctor.last24h.rateLimitProviders ?? [],
    fallbackCascades: home.doctor.last24h.fallbackCascades ?? [],
    heavyAvailable: home.models.availableByCapability.heavy,
  });

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
      const kind = current === "crit-12h"
        ? "vast.runway_critical"
        : current === "warn-24h"
          ? "vast.runway_warning"
          : "vast.runway";
      writeEvent({
        kind,
        severity: vastSeverity(next.vastRunwayBucket),
        entityType: "vast",
        entityId: "runway",
        summary: `Vast runway: ${prev.vastRunwayBucket ?? "unknown"} -> ${current} (${home.vast.runwayHours ?? "unknown"}h)`,
        payload: {
          previous: prev.vastRunwayBucket,
          current,
          runwayHours: home.vast.runwayHours,
          hourlyRate: home.vast.hourlyRate,
          balance: home.vast.balance,
          credit: home.vast.credit,
        },
        dedupeKey: dedupeKey("vast", kind, current),
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

  if (prev.heavyTierBucket !== null && next.heavyTierBucket !== null && prev.heavyTierBucket !== next.heavyTierBucket) {
    try {
      writeEvent({
        kind: "model.heavy_tier_exhausted",
        severity: heavyTierSeverity(next.heavyTierBucket),
        entityType: "model",
        entityId: "heavy",
        summary: `Heavy model tier: ${prev.heavyTierBucket} → ${next.heavyTierBucket}`,
        payload: {
          previous: prev.heavyTierBucket,
          current: next.heavyTierBucket,
          availableByCapability: home.models.availableByCapability,
          qualitySummary: home.models.qualitySummary,
        },
        dedupeKey: dedupeKey("model", "heavy_tier", next.heavyTierBucket),
      });
    } catch (error) {
      console.error("[sampler] model.heavy_tier_exhausted failed", error);
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

  const memoryPressure = getMemoryPressure();
  if (
    prev.infraMemoryPressureBucket !== null &&
    next.infraMemoryPressureBucket === "pressure" &&
    prev.infraMemoryPressureBucket !== next.infraMemoryPressureBucket &&
    memoryPressure
  ) {
    try {
      writeEvent({
        kind: "infra.memory_pressure",
        severity: infraMemoryPressureSeverity(memoryPressure),
        entityType: "hetzner",
        entityId: "memory",
        summary: `Hetzner memory pressure: ${Math.round(memoryPressure.currentPct * 10) / 10}% used for ${formatAge(memoryPressure.newestTs - memoryPressure.oldestTs)}`,
        payload: memoryPressure,
        dedupeKey: dedupeKey("infra", "memory_pressure", "active"),
      });
    } catch (error) {
      console.error("[sampler] infra.memory_pressure failed", error);
    }
  }

  if (
    prev.infraDiskPressureBucket !== null &&
    next.infraDiskPressureBucket === "pressure" &&
    prev.infraDiskPressureBucket !== next.infraDiskPressureBucket
  ) {
    try {
      writeEvent({
        kind: "infra.disk_pressure",
        severity: infraDiskPressureSeverity(home.hetzner.diskUsedPct),
        entityType: "hetzner",
        entityId: "disk",
        summary: `Hetzner disk pressure: ${home.hetzner.diskUsedPct}% used`,
        payload: { diskUsedPct: home.hetzner.diskUsedPct },
        dedupeKey: dedupeKey("infra", "disk_pressure", "active"),
      });
    } catch (error) {
      console.error("[sampler] infra.disk_pressure failed", error);
    }
  }

  if (prev.infraRestartStormKey !== next.infraRestartStormKey && next.infraRestartStormKey) {
    for (const storm of getServiceRestartStorms(RESTART_STORM_WINDOW_MS, 4)) {
      try {
        writeEvent({
          kind: "infra.restart_storm",
          severity: "error",
          entityType: "service",
          entityId: storm.service,
          summary: `${storm.service} restarted ${storm.restarts} times in ${storm.windowMinutes}m`,
          payload: storm,
          dedupeKey: dedupeKey("infra", `${storm.service}:restart_storm`, "active"),
        });
      } catch (error) {
        console.error("[sampler] infra.restart_storm failed", error);
      }
    }
  }

  if (prev.infraTunnelFlappingKey !== next.infraTunnelFlappingKey && next.infraTunnelFlappingKey) {
    for (const storm of getServiceRestartStorms(TUNNEL_FLAPPING_WINDOW_MS, 3, new Set(["vast-tunnel"]))) {
      try {
        writeEvent({
          kind: "infra.tunnel_flapping",
          severity: "error",
          entityType: "service",
          entityId: storm.service,
          summary: `${storm.service} flapped ${storm.restarts} times in ${storm.windowMinutes}m`,
          payload: storm,
          dedupeKey: dedupeKey("infra", `${storm.service}:tunnel_flapping`, "active"),
        });
      } catch (error) {
        console.error("[sampler] infra.tunnel_flapping failed", error);
      }
    }
  }

  const costBurnSpike = getCostBurnSpike();
  if (
    prev.costBurnBucket !== null &&
    next.costBurnBucket === "spike" &&
    prev.costBurnBucket !== next.costBurnBucket &&
    costBurnSpike
  ) {
    try {
      writeEvent({
        kind: "vast.burn_spike",
        severity: costBurnSpikeSeverity(costBurnSpike),
        entityType: "vast",
        entityId: "burn_rate",
        summary: `Vast burn spike: $${costBurnSpike.currentHourlyRate.toFixed(2)}/h vs $${costBurnSpike.baselineHourlyRate.toFixed(2)}/h baseline (${Math.round(costBurnSpike.multiplier * 10) / 10}x)`,
        payload: costBurnSpike,
        dedupeKey: dedupeKey("vast", "burn_spike", "active"),
      });
    } catch (error) {
      console.error("[sampler] vast.burn_spike failed", error);
    }
  }

  const diskProjection = getDiskProjection();
  if (
    prev.diskProjectionBucket !== null &&
    next.diskProjectionBucket === "projected-90" &&
    prev.diskProjectionBucket !== next.diskProjectionBucket &&
    diskProjection
  ) {
    try {
      writeEvent({
        kind: "disk.projected_full",
        severity: diskProjectionSeverity(diskProjection),
        entityType: "hetzner",
        entityId: "disk",
        summary: `Disk projects to 90% in ${formatDays(diskProjection.daysTo90)} (${Math.round(diskProjection.currentPct * 10) / 10}% now, +${Math.round(diskProjection.dailyGrowthPct * 10) / 10} pct/day)`,
        payload: {
          currentPct: diskProjection.currentPct,
          dailyGrowthPct: diskProjection.dailyGrowthPct,
          projectedPct7d: diskProjection.projectedPct7d,
          daysTo90: diskProjection.daysTo90,
          sampleCount: diskProjection.sampleCount,
          oldestTs: diskProjection.oldestTs,
          newestTs: diskProjection.newestTs,
        },
        dedupeKey: dedupeKey("hetzner", "disk.projected_full", "projected-90"),
      });
    } catch (error) {
      console.error("[sampler] disk.projected_full failed", error);
    }
  }

  const doctorLog = getDoctorLogFinding();
  if (
    prev.doctorLogBucket !== null &&
    doctorLog &&
    doctorLog.bucket !== "ok" &&
    prev.doctorLogBucket !== doctorLog.bucket
  ) {
    try {
      writeEvent({
        kind: "disk.doctor_log_large",
        severity: doctorLogSeverity(doctorLog),
        entityType: "file",
        entityId: "doctor-log.jsonl",
        summary: `Doctor log is ${Math.round(doctorLog.sizeBytes / 1024 / 1024)} MB (${doctorLog.bucket})`,
        payload: doctorLog,
        dedupeKey: dedupeKey("disk", "doctor-log", doctorLog.bucket),
      });
    } catch (error) {
      console.error("[sampler] disk.doctor_log_large failed", error);
    }
  }

  const backupFreshness = getBackupFreshness();
  if (
    prev.backupFreshnessBucket !== null &&
    backupFreshness &&
    backupFreshness.bucket !== "fresh" &&
    prev.backupFreshnessBucket !== backupFreshness.bucket
  ) {
    try {
      writeEvent({
        kind: "backup.stale",
        severity: backupFreshnessSeverity(backupFreshness),
        entityType: "backup",
        entityId: "mimule",
        summary: backupFreshness.ageMs === null
          ? `No backups found in ${backupFreshness.root}`
          : `Newest backup is ${formatAge(backupFreshness.ageMs)} old`,
        payload: backupFreshness,
        dedupeKey: dedupeKey("backup", "mimule", backupFreshness.bucket),
      });
    } catch (error) {
      console.error("[sampler] backup.stale failed", error);
    }
  }

  if (prev.queueHealthBucket !== null && next.queueHealthBucket !== null && prev.queueHealthBucket !== next.queueHealthBucket) {
    try {
      const oldestApprovalAgeMs = getOldestApprovalAgeMs(home);
      const plannedKind = queueHealthEventKind(next.queueHealthBucket);
      const largestStage = getLargestPipelineStage(home);
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
      if (plannedKind !== "queue.health") {
        writeEvent({
          kind: plannedKind,
          severity: queueHealthSeverity(next.queueHealthBucket),
          entityType: "pipeline",
          entityId: "queue",
          summary: `Pipeline ${plannedKind}: ${home.autopipeline.queueDepth} queued, ${home.autopipeline.approvalsWaiting} approvals, oldest ${formatAge(oldestApprovalAgeMs)}`,
          payload: {
            bucket: next.queueHealthBucket,
            queueDepth: home.autopipeline.queueDepth,
            approvalsWaiting: home.autopipeline.approvalsWaiting,
            oldestApprovalAgeMs,
            paused: home.autopipeline.paused,
            pauseReason: home.autopipeline.pauseReason,
            largestStage,
            stageBreakdown: home.autopipeline.stageBreakdown,
          },
          dedupeKey: dedupeKey("queue", plannedKind, next.queueHealthBucket),
        });
      }
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

  if (prev.providerRateLimitHotKey !== next.providerRateLimitHotKey && next.providerRateLimitHotKey) {
    for (const signal of home.doctor.last24h.rateLimitProviders ?? []) {
      try {
        writeEvent({
          kind: "provider.rate_limit_hot",
          severity: signal.count >= 6 ? "error" : "warn",
          entityType: "provider",
          entityId: signal.provider,
          summary: `${signal.provider} rate-limit hot: ${signal.count} doctor entries in 10m`,
          payload: signal,
          dedupeKey: dedupeKey("provider", `${signal.provider}:rate_limit_hot`, "hot"),
        });
      } catch (error) {
        console.error("[sampler] provider.rate_limit_hot failed", error);
      }
    }
  }

  if (prev.fallbackCascadeKey !== next.fallbackCascadeKey && next.fallbackCascadeKey) {
    for (const signal of home.doctor.last24h.fallbackCascades ?? []) {
      try {
        writeEvent({
          kind: "model.fallback_cascade",
          severity: "warn",
          entityType: "model",
          entityId: signal.model,
          summary: `${signal.model} failed ${signal.count} times in a row at ${signal.stage}`,
          payload: signal,
          dedupeKey: dedupeKey("model", `${signal.model}:${signal.stage}:fallback_cascade`, "active"),
        });
      } catch (error) {
        console.error("[sampler] model.fallback_cascade failed", error);
      }
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
