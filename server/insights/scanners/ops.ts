import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { EvidenceRef } from "../../api/types.ts";
import type { Insight, InsightInput } from "../types.ts";
import { getDashboardDb } from "../../db/dashboard.ts";
import { upsertInsight, resolveStaleInsights } from "../store.ts";
import { writeActionAudit } from "../../db/writer.ts";
import { getServiceStatuses, getHetznerStats, type ServicePill, type HetznerStats } from "../../adapters/system.ts";
import { getGpuUtilFromHealth } from "../../adapters/vast.ts";
import { getModelHealth, type ModelHealth } from "../../adapters/models.ts";
import { getDoctorStats, type DoctorStats } from "../../adapters/doctor.ts";
import type { PipelineState } from "../../adapters/pipeline.ts";
import {
  getBackupFreshness,
  getDoctorLogFinding,
  type BackupFreshness,
  type DoctorLogFinding,
} from "../../db/sampler.ts";
import { listApprovalRequests, type ApprovalRequest } from "../../governance/approvals.ts";

type ScanResult = {
  scannedAt: number;
  findings: Insight[];
  resolvedCount: number;
};

const PIPELINE_STATE_PATH = "/var/lib/mimule/pipeline-state.json";
const MODEL_COOLDOWNS_PATH = "/var/lib/mimule/model-cooldowns.json";

// Services whose outage is customer-facing or breaks the whole stack.
const CRITICAL_SERVICES = new Set(["newsbites", "litellm", "control-surface", "newsbites-autopipeline"]);

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const APPROVAL_WARN_MS = 60 * 60 * 1000;
const APPROVAL_CRITICAL_MS = 6 * 60 * 60 * 1000;

function evidence(label: string, kind: EvidenceRef["kind"], ref: string): EvidenceRef {
  return { label, kind, ref, redacted: true };
}

function safeInsightId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "");
}

// Sync read of the last-written pipeline state file (the autopipeline writes it
// on every state change). Kept sync so the whole scan matches the other
// scanners' synchronous signature.
export function readPipelineStateSync(): PipelineState {
  try {
    return JSON.parse(readFileSync(PIPELINE_STATE_PATH, "utf8")) as PipelineState;
  } catch {
    return { queue: [], current: null, paused: false, pauseReason: null };
  }
}

export type FailedTimer = {
  unit: string;
  active?: string | null;
  sub?: string | null;
  raw?: string | null;
};

export type StuckCooldown = {
  model: string;
  expiresAt: number;
  startedAt: number | null;
  reason: string | null;
};

type OpsScanProbeOverrides = Partial<{
  getServiceStatuses: () => ServicePill[];
  getHetznerStats: () => HetznerStats;
  getGpuUtilFromHealth: () => number | null;
  readPipelineStateSync: () => PipelineState;
  getModelHealth: () => ModelHealth;
  getDoctorStats: () => DoctorStats;
  getDoctorLogFinding: () => DoctorLogFinding | null;
  getBackupFreshness: () => BackupFreshness | null;
  getFailedTimers: () => FailedTimer[];
  getStuckCooldowns: (now: number) => StuckCooldown[];
  listPendingApprovals: () => ApprovalRequest[];
}>;

let opsScanProbeOverrides: OpsScanProbeOverrides | null = null;

export function setOpsScanProbeOverridesForTest(overrides: OpsScanProbeOverrides | null): void {
  opsScanProbeOverrides = overrides;
}

export function getFailedTimers(): FailedTimer[] {
  let raw = "";
  try {
    raw = execFileSync("systemctl", [
      "list-units",
      "--type=timer",
      "--state=failed",
      "--all",
      "--no-legend",
      "--no-pager",
    ], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];
  }

  const failed: FailedTimer[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [unit, , active, sub] = trimmed.split(/\s+/, 4);
    if (!unit?.endsWith(".timer")) continue;
    failed.push({ unit, active: active ?? null, sub: sub ?? null, raw: trimmed.slice(0, 500) });
  }
  return failed;
}

export function getStuckCooldowns(now = Date.now()): StuckCooldown[] {
  const path = process.env.DASHBOARD_MODEL_COOLDOWNS_PATH || MODEL_COOLDOWNS_PATH;
  let raw: Record<string, { expiresAt?: number; startedAt?: number; reason?: string }> = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as typeof raw;
  } catch {
    return [];
  }

  const out: StuckCooldown[] = [];
  for (const [model, entry] of Object.entries(raw)) {
    const expiresAt = typeof entry?.expiresAt === "number" ? entry.expiresAt : null;
    if (expiresAt === null || expiresAt > now) continue;
    out.push({
      model,
      expiresAt,
      startedAt: typeof entry.startedAt === "number" ? entry.startedAt : null,
      reason: typeof entry.reason === "string" ? entry.reason : null,
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

// ── Pure mapping functions (data → finding descriptors). Deterministic and
//    unit-testable without a live system or the dashboard DB. ───────────────

export function mapServiceFindings(pills: ServicePill[], now: number): InsightInput[] {
  const out: InsightInput[] = [];
  for (const pill of pills) {
    const critical = CRITICAL_SERVICES.has(pill.name);
    if (pill.status !== "failed" && !(pill.status === "inactive" && critical)) continue;
    out.push({
      id: `insight_ops_service_down_${pill.name}`,
      sourceKey: `ops:service-down:${pill.name}`,
      domain: "ops",
      severity: critical ? "critical" : "high",
      title: `Service ${pill.name} is down`,
      plainSummary: `The ${pill.name} service reports "${pill.status}". ${critical ? "This is a critical stack service — " : ""}Restart it from the infrastructure page and check its journal for why it stopped.`,
      confidence: 0.95,
      evidenceRefs: [
        evidence("systemctl status", "command", `systemctl is-active ${pill.name}`),
        evidence("Infrastructure page", "api", "/api/infra"),
      ],
      // Restarting a service is reversible but customer-facing → manual Apply (review tier).
      actionDescriptorId: `start-job:service:${pill.name}`,
      manualPageHref: "/infra",
      createdAt: now,
    });
  }
  return out;
}

export function mapHetznerFindings(stats: HetznerStats, now: number): InsightInput[] {
  const out: InsightInput[] = [];
  if (stats.diskUsedPct >= 85) {
    out.push({
      id: "insight_ops_disk_pressure",
      sourceKey: "ops:disk-pressure",
      domain: "ops",
      severity: stats.diskUsedPct >= 95 ? "high" : "medium",
      title: "Disk usage is high on the host",
      plainSummary: `The root filesystem is ${stats.diskUsedPct}% full (${stats.diskUsedGb}/${stats.diskTotalGb} GB). Prune old backups, Docker images, and build caches before it fills up and wedges services.`,
      confidence: 0.9,
      evidenceRefs: [evidence("df -h /", "command", "df -BG /")],
      actionDescriptorId: null,
      manualPageHref: "/infra",
      createdAt: now,
    });
  }
  const memUsedPct = stats.memTotalKb > 0 ? Math.round((stats.memUsedKb / stats.memTotalKb) * 100) : 0;
  if (memUsedPct >= 90) {
    out.push({
      id: "insight_ops_mem_pressure",
      sourceKey: "ops:mem-pressure",
      domain: "ops",
      severity: memUsedPct >= 96 ? "high" : "medium",
      title: "Memory usage is high on the host",
      plainSummary: `Memory is ${memUsedPct}% used. Sustained pressure risks the OOM killer terminating live services. Check for runaway processes on the infrastructure page.`,
      confidence: 0.85,
      evidenceRefs: [evidence("/proc/meminfo", "file", "/proc/meminfo")],
      actionDescriptorId: null,
      manualPageHref: "/infra",
      createdAt: now,
    });
  }
  return out;
}

export function mapGpuFindings(gpuUtil: number | null, now: number): InsightInput[] {
  if (gpuUtil !== null) return [];
  return [{
    id: "insight_ops_gpu_unavailable",
    sourceKey: "ops:gpu-down",
    domain: "ops",
    severity: "high",
    title: "The GPU backend looks unavailable",
    plainSummary: "No GPU utilisation is being reported by the health probe — the Vast.ai tunnel or Ollama may be down. Editorial work will fall back to cloud models until it recovers.",
    confidence: 0.7,
    evidenceRefs: [evidence("GPU health file", "file", "/var/lib/mimule/gpu-health.json")],
    // Restarting the tunnel is the standard fix but is infra-affecting → manual Apply.
    actionDescriptorId: "start-job:service:vast-tunnel",
    manualPageHref: "/infra",
    createdAt: now,
  }];
}

export function mapPipelineFindings(state: PipelineState, now: number): InsightInput[] {
  const out: InsightInput[] = [];
  if (state.paused) {
    out.push({
      id: "insight_ops_pipeline_paused",
      sourceKey: "ops:pipeline-paused",
      domain: "ops",
      severity: "medium",
      title: "The editorial pipeline is paused",
      plainSummary: `The autopipeline is paused${state.pauseReason ? ` (${state.pauseReason})` : ""}. No stories will progress until it is resumed.`,
      confidence: 0.95,
      evidenceRefs: [evidence("Pipeline state", "file", PIPELINE_STATE_PATH)],
      actionDescriptorId: null,
      manualPageHref: "/autopipeline",
      createdAt: now,
    });
  }
  for (const item of state.queue) {
    if (!item.running || !item.createdAt) continue;
    if (now - item.createdAt < TWO_HOURS_MS) continue;
    out.push({
      id: `insight_ops_stuck_story_${item.id}`,
      sourceKey: `ops:stuck-story:${item.id}`,
      domain: "ops",
      severity: "medium",
      title: `A story has been stuck in "${item.stage}"`,
      plainSummary: `Story ${item.slug ?? item.id} has been running in the "${item.stage}" stage for over 2 hours. It may have hit a stalled model call — run a doctor scan or requeue it.`,
      confidence: 0.75,
      evidenceRefs: [evidence("Pipeline queue", "api", "/api/autopipeline")],
      actionDescriptorId: null,
      manualPageHref: "/autopipeline",
      createdAt: now,
    });
  }
  return out;
}

export function mapModelFindings(health: ModelHealth, now: number): InsightInput[] {
  const out: InsightInput[] = [];
  const { heavy, medium, light } = health.availableByCapability;
  if (heavy === 0 && medium === 0 && light === 0 && health.checkedAt > 0) {
    out.push({
      id: "insight_ops_provider_outage",
      sourceKey: "ops:provider-outage",
      domain: "ops",
      severity: "critical",
      title: "No models are currently available",
      plainSummary: "The last health check found zero available models across every capability tier. All providers appear to be failing — editorial and coding work cannot run until one recovers.",
      confidence: 0.9,
      evidenceRefs: [evidence("Model health", "file", "/var/lib/mimule/model-health.json")],
      // Re-pointing the gateway to the healthiest model is reversible (TTL'd) → manual Apply.
      actionDescriptorId: "start-job:gateway:route-healthiest",
      manualPageHref: "/models",
      createdAt: now,
    });
  }

  if (health.lastFullCheckAt > 0 && now - health.lastFullCheckAt > SIX_HOURS_MS) {
    const hours = Math.round((now - health.lastFullCheckAt) / (60 * 60 * 1000));
    out.push({
      id: "insight_ops_discovery_stale",
      sourceKey: "ops:discovery-stale",
      domain: "ops",
      severity: "low",
      title: "Model discovery data is stale",
      plainSummary: `The last full model-health check ran ${hours}h ago (expected every 5h). Routing decisions may be based on outdated availability. Re-run the model-health check.`,
      confidence: 0.85,
      evidenceRefs: [evidence("Model health", "file", "/var/lib/mimule/model-health.json")],
      // Re-running discovery is idempotent + non-customer-facing → SAFE auto-apply.
      actionDescriptorId: "start-job:model-health:all",
      manualPageHref: "/models",
      createdAt: now,
    });
  }

  if (health.cooldownsActive >= 5) {
    out.push({
      id: "insight_ops_cooldowns_piling",
      sourceKey: "ops:cooldowns-piling",
      domain: "ops",
      severity: "medium",
      title: "Many models are in cooldown",
      plainSummary: `${health.cooldownsActive} models are currently in cooldown. If this keeps growing the fallback chain may exhaust healthy options — review the models page and clear stale cooldowns.`,
      confidence: 0.8,
      evidenceRefs: [evidence("Cooldowns", "file", "/var/lib/mimule/model-cooldowns.json")],
      actionDescriptorId: null,
      manualPageHref: "/models",
      createdAt: now,
    });
  }

  if (health.qualitySummary.blocked > 0) {
    out.push({
      id: "insight_ops_models_blocked",
      sourceKey: "ops:models-blocked",
      domain: "ops",
      severity: "low",
      title: "Some models are blocked for quality",
      plainSummary: `${health.qualitySummary.blocked} model(s) are blocked for poor output quality. Confirm this is intended; if a block is stale, clear it from the models page.`,
      confidence: 0.75,
      evidenceRefs: [evidence("Model quality", "file", "/var/lib/mimule/model-quality.json")],
      actionDescriptorId: null,
      manualPageHref: "/models",
      createdAt: now,
    });
  }
  return out;
}

export function mapDoctorFindings(stats: DoctorStats, now: number): InsightInput[] {
  if (stats.total < 10) return [];
  const errorRate = (stats.total - stats.success) / stats.total;
  if (errorRate <= 0.5) return [];
  return [{
    id: "insight_ops_doctor_error_spike",
    sourceKey: "ops:doctor-error-spike",
    domain: "ops",
    severity: errorRate > 0.75 ? "medium" : "low",
    title: "Pipeline error rate is elevated",
    plainSummary: `${Math.round(errorRate * 100)}% of recent pipeline decisions logged errors (${stats.total - stats.success}/${stats.total}). Open the doctor page to see the failing models and stages.`,
    confidence: 0.8,
    evidenceRefs: [evidence("Doctor log", "file", "/var/lib/mimule/doctor-log.jsonl")],
    // A doctor scan is diagnostic; running it is a review-tier action.
    actionDescriptorId: "start-job:doctor:scan",
    manualPageHref: "/doctor",
    createdAt: now,
  }];
}

export function mapBackupFreshnessFindings(freshness: BackupFreshness | null, now: number): InsightInput[] {
  if (!freshness || freshness.bucket === "fresh") return [];
  const missing = freshness.bucket === "missing";
  const summary = missing
    ? `No backup artifacts were found in ${freshness.root}. Run or repair the backup job before the next failure leaves the stack without a restore point.`
    : `The newest backup is ${freshness.ageMs === null ? "stale" : `${Math.round(freshness.ageMs / 3_600_000)}h old`}. Run the backup timer and check why the scheduled backup did not refresh.`;
  return [{
    id: "insight_ops_backup_stale",
    sourceKey: "ops:backup-stale",
    domain: "ops",
    severity: missing ? "high" : "medium",
    title: missing ? "Backups are missing" : "Backups are stale",
    plainSummary: summary,
    confidence: missing ? 0.85 : 0.9,
    evidenceRefs: [
      evidence("Backup root", "file", freshness.root),
      evidence("Newest backup", "file", freshness.newestPath ?? `${freshness.root}/<none>`),
    ],
    actionDescriptorId: null,
    manualPageHref: "/infra",
    createdAt: now,
  }];
}

export function mapDoctorLogSizeFindings(log: DoctorLogFinding | null, now: number): InsightInput[] {
  if (!log || log.bucket === "ok") return [];
  const sizeMb = Math.round(log.sizeBytes / (1024 * 1024));
  return [{
    id: "insight_ops_doctor_log_large",
    sourceKey: "ops:doctor-log-large",
    domain: "ops",
    severity: log.bucket === "huge" ? "high" : "medium",
    title: "Doctor log is large",
    plainSummary: `The doctor log is ${sizeMb} MB. Rotate it before scans and UI reads slow down or the host wastes disk on old diagnostics.`,
    confidence: 0.95,
    evidenceRefs: [evidence("Doctor log", "file", log.path)],
    actionDescriptorId: "start-job:infra:doctor-log-rotate",
    manualPageHref: "/infra",
    createdAt: now,
  }];
}

export function mapFailedTimerFindings(timers: FailedTimer[], now: number): InsightInput[] {
  return timers.map((timer) => {
    const unit = timer.unit.endsWith(".timer") ? timer.unit : `${timer.unit}.timer`;
    return {
      id: `insight_ops_failed_timer_${safeInsightId(unit)}`,
      sourceKey: `ops:failed-timer:${unit}`,
      domain: "ops",
      severity: "high",
      title: `Timer ${unit} is failed`,
      plainSummary: `${unit} is in a failed state. Inspect the timer and its paired service from the infrastructure page, then run the maintenance job once it is healthy.`,
      confidence: 0.9,
      evidenceRefs: [
        evidence("Failed timers", "command", "systemctl list-units --type=timer --state=failed"),
        evidence("Timer state", "command", `systemctl show ${unit}`),
      ],
      actionDescriptorId: null,
      manualPageHref: "/infra",
      createdAt: now,
    } satisfies InsightInput;
  });
}

export function mapStuckCooldownFindings(cooldowns: StuckCooldown[], now: number): InsightInput[] {
  return cooldowns.map((cooldown) => ({
    id: `insight_ops_cooldown_stuck_${safeInsightId(cooldown.model)}`,
    sourceKey: `ops:cooldown-stuck:${cooldown.model}`,
    domain: "ops",
    severity: "low",
    title: `Model cooldown is stuck for ${cooldown.model}`,
    plainSummary: `${cooldown.model} still has a cooldown record even though it expired ${Math.max(0, Math.round((now - cooldown.expiresAt) / 60000))}m ago. Clear the stale cooldown so routing can consider the model again.`,
    confidence: 0.85,
    evidenceRefs: [evidence("Model cooldowns", "file", process.env.DASHBOARD_MODEL_COOLDOWNS_PATH || MODEL_COOLDOWNS_PATH)],
    actionDescriptorId: `mutate-policy:model:${cooldown.model}:cooldown-clear`,
    manualPageHref: "/models",
    createdAt: now,
  }));
}

export function mapApprovalAgingFindings(approvals: ApprovalRequest[], now: number): InsightInput[] {
  const pending = approvals.filter((approval) => approval.status === "pending");
  if (pending.length === 0) return [];
  const oldest = pending.reduce((min, approval) => Math.min(min, approval.requestedAt), Number.POSITIVE_INFINITY);
  const ageMs = now - oldest;
  if (!Number.isFinite(ageMs) || ageMs < APPROVAL_WARN_MS) return [];
  return [{
    id: "insight_ops_approvals_aging",
    sourceKey: "ops:approvals-aging",
    domain: "ops",
    severity: ageMs >= APPROVAL_CRITICAL_MS ? "high" : "medium",
    title: "Governance approvals are aging",
    plainSummary: `${pending.length} approval request(s) are pending, and the oldest has waited ${Math.round(ageMs / 3_600_000)}h. Review or reject stale requests so work is not silently blocked.`,
    confidence: 0.85,
    evidenceRefs: [evidence("Governance approvals", "db", "governance_approvals")],
    actionDescriptorId: null,
    manualPageHref: "/governance",
    createdAt: now,
  }];
}

function add(results: Insight[], input: InsightInput, emittedSourceKeys: string[]): void {
  const row = upsertInsight(input);
  if (row) {
    results.push(row);
    if (input.sourceKey) emittedSourceKeys.push(input.sourceKey);
  }
}

// Gather every operational signal (each guarded so one failure can't sink the
// whole scan), persist findings, and resolve any ops finding that has cleared.
export function runOpsScan(): ScanResult {
  const scannedAt = Date.now();
  const findings: Insight[] = [];
  if (!getDashboardDb()) return { scannedAt, findings, resolvedCount: 0 };

  const descriptors: InsightInput[] = [];
  const collect = (fn: () => InsightInput[]): void => {
    try { descriptors.push(...fn()); } catch (err) {
      console.error("[ops-scan] detector failed", err instanceof Error ? err.message : err);
    }
  };

  collect(() => mapServiceFindings((opsScanProbeOverrides?.getServiceStatuses ?? getServiceStatuses)(), scannedAt));
  collect(() => mapHetznerFindings((opsScanProbeOverrides?.getHetznerStats ?? getHetznerStats)(), scannedAt));
  collect(() => mapGpuFindings((opsScanProbeOverrides?.getGpuUtilFromHealth ?? getGpuUtilFromHealth)(), scannedAt));
  collect(() => mapPipelineFindings((opsScanProbeOverrides?.readPipelineStateSync ?? readPipelineStateSync)(), scannedAt));
  collect(() => mapModelFindings((opsScanProbeOverrides?.getModelHealth ?? getModelHealth)(), scannedAt));
  collect(() => mapDoctorFindings((opsScanProbeOverrides?.getDoctorStats ?? getDoctorStats)(), scannedAt));
  collect(() => mapBackupFreshnessFindings((opsScanProbeOverrides?.getBackupFreshness ?? getBackupFreshness)(), scannedAt));
  collect(() => mapDoctorLogSizeFindings((opsScanProbeOverrides?.getDoctorLogFinding ?? getDoctorLogFinding)(), scannedAt));
  collect(() => mapFailedTimerFindings((opsScanProbeOverrides?.getFailedTimers ?? getFailedTimers)(), scannedAt));
  collect(() => mapStuckCooldownFindings((opsScanProbeOverrides?.getStuckCooldowns ?? getStuckCooldowns)(scannedAt), scannedAt));
  collect(() => mapApprovalAgingFindings((opsScanProbeOverrides?.listPendingApprovals ?? (() => listApprovalRequests("pending")))(), scannedAt));

  const emittedSourceKeys: string[] = [];
  for (const descriptor of descriptors) add(findings, descriptor, emittedSourceKeys);

  const resolved = resolveStaleInsights(
    "ops:",
    emittedSourceKeys,
    "The operational scanner confirmed this condition has cleared.",
  );
  for (const insight of resolved) {
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-resolve",
      targetType: "insight",
      targetId: insight.id,
      risk: "low",
      resultStatus: "success",
      result: "The operational scanner confirmed this condition has cleared.",
      request: { sourceKey: insight.sourceKey ?? insight.id },
    });
  }

  return { scannedAt, findings, resolvedCount: resolved.length };
}
