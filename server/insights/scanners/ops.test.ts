import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../../db/dashboard.ts";
import { getInsight } from "../store.ts";
import type { ServicePill, HetznerStats } from "../../adapters/system.ts";
import type { ModelHealth } from "../../adapters/models.ts";
import type { DoctorStats } from "../../adapters/doctor.ts";
import type { PipelineState } from "../../adapters/pipeline.ts";
import type { ApprovalRequest } from "../../governance/approvals.ts";
import {
  mapServiceFindings,
  mapHetznerFindings,
  mapGpuFindings,
  mapPipelineFindings,
  mapModelFindings,
  mapDoctorFindings,
  mapBackupFreshnessFindings,
  mapDoctorLogSizeFindings,
  mapFailedTimerFindings,
  mapStuckCooldownFindings,
  mapApprovalAgingFindings,
  runOpsScan,
  setOpsScanProbeOverridesForTest,
  type FailedTimer,
  type StuckCooldown,
} from "./ops.ts";

const NOW = 1_700_000_000_000;

function hetzner(overrides: Partial<HetznerStats> = {}): HetznerStats {
  return {
    load1: 0.5, load5: 0.5, load15: 0.5,
    memTotalKb: 16_000_000, memUsedKb: 4_000_000, memAvailableKb: 12_000_000,
    diskTotalGb: 100, diskUsedGb: 40, diskUsedPct: 40,
    ...overrides,
  };
}

function modelHealth(overrides: Partial<ModelHealth> = {}): ModelHealth {
  return {
    checkedAt: NOW, lastFullCheckAt: NOW, lastQuickCheckAt: NOW,
    bestLocal: "editorial-heavy", bestCloudHeavy: "cloud-heavy", bestCloudFast: "cloud-fast",
    availableByCapability: { heavy: 3, medium: 5, light: 8 },
    qualitySummary: { blocked: 0, degraded: 0, probation: 0 },
    newModelsAdded: [], cooldownsActive: 0, soonestCooldownExpiresMs: null,
    ...overrides,
  };
}

function doctorStats(overrides: Partial<DoctorStats> = {}): DoctorStats {
  return {
    total: 0, success: 0, errorClasses: [], topFailingModels: [], topFailingStages: [],
    verdictMix: [], rateLimitProviders: [], fallbackCascades: [], lastDecision: null,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "ar_test",
    workflowId: "wf_test",
    runId: "run_test",
    tenantId: "mimule",
    requestedAt: NOW - 2 * 60 * 60 * 1000,
    requestedBy: "operator",
    status: "pending",
    approvals: [],
    requiredCount: 1,
    ...overrides,
  };
}

function neutralOpsOverrides() {
  return {
    getServiceStatuses: () => [{ name: "control-surface", status: "active" as const }],
    getHetznerStats: () => hetzner(),
    getGpuUtilFromHealth: () => 42,
    readPipelineStateSync: () => ({ queue: [], current: null, paused: false, pauseReason: null }),
    getModelHealth: () => modelHealth(),
    getDoctorStats: () => doctorStats(),
    getDoctorLogFinding: () => null,
    getBackupFreshness: () => ({ root: "/tmp/backups", newestPath: "/tmp/backups/latest", newestMtimeMs: NOW, ageMs: 5_000, bucket: "fresh" as const }),
    getFailedTimers: () => [] as FailedTimer[],
    getStuckCooldowns: () => [] as StuckCooldown[],
    listPendingApprovals: () => [] as ApprovalRequest[],
  };
}

describe("ops scanner: pure mapping", () => {
  test("a failed unit flags (high, or critical for a critical service)", () => {
    const pills: ServicePill[] = [
      { name: "goblin_game", status: "failed" },
      { name: "litellm", status: "failed" },
      { name: "newsbites", status: "active" },
    ];
    const out = mapServiceFindings(pills, NOW);
    expect(out).toHaveLength(2);

    const goblin = out.find((f) => f.sourceKey === "ops:service-down:goblin_game")!;
    expect(goblin.domain).toBe("ops");
    expect(goblin.severity).toBe("high");
    expect(goblin.manualPageHref).toBe("/infra");
    expect(goblin.title).toContain("is down");

    const litellm = out.find((f) => f.sourceKey === "ops:service-down:litellm")!;
    expect(litellm.severity).toBe("critical");
  });

  test("a non-critical inactive unit does NOT flag (normal resting state for oneshot/triggered units)", () => {
    const out = mapServiceFindings(
      [{ name: "mimule-orchestrator", status: "inactive" }, { name: "mimule-overseer", status: "inactive" }],
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  test("a critical service that is inactive still flags as critical", () => {
    const out = mapServiceFindings([{ name: "litellm", status: "inactive" }], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].sourceKey).toBe("ops:service-down:litellm");
    expect(out[0].severity).toBe("critical");
  });

  test("all services healthy emits nothing", () => {
    const out = mapServiceFindings(
      [{ name: "newsbites", status: "active" }, { name: "litellm", status: "active" }],
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  test("disk over 95% is high, 85-95% is medium, under 85% is silent", () => {
    expect(mapHetznerFindings(hetzner({ diskUsedPct: 97 }), NOW)[0].severity).toBe("high");
    expect(mapHetznerFindings(hetzner({ diskUsedPct: 88 }), NOW)[0].severity).toBe("medium");
    expect(mapHetznerFindings(hetzner({ diskUsedPct: 70 }), NOW)).toHaveLength(0);
  });

  test("memory over 90% used emits a finding", () => {
    const out = mapHetznerFindings(hetzner({ memTotalKb: 100, memUsedKb: 95, memAvailableKb: 5 }), NOW);
    expect(out.some((f) => f.sourceKey === "ops:mem-pressure")).toBe(true);
  });

  test("gpu unavailable (null util) emits a high finding; present util is silent", () => {
    const out = mapGpuFindings(null, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
    expect(out[0].sourceKey).toBe("ops:gpu-down");
    expect(mapGpuFindings(42, NOW)).toHaveLength(0);
  });

  test("paused pipeline and stuck story emit findings; fresh story does not", () => {
    const state: PipelineState = {
      queue: [
        { id: "s1", slug: "old-story", stage: "write", priority: 1, waitingApproval: false, running: true, createdAt: NOW - 3 * 60 * 60 * 1000 },
        { id: "s2", slug: "fresh", stage: "write", priority: 1, waitingApproval: false, running: true, createdAt: NOW - 5 * 60 * 1000 },
      ],
      current: null, paused: true, pauseReason: "manual",
    };
    const out = mapPipelineFindings(state, NOW);
    expect(out.some((f) => f.sourceKey === "ops:pipeline-paused")).toBe(true);
    expect(out.some((f) => f.sourceKey === "ops:stuck-story:s1")).toBe(true);
    expect(out.some((f) => f.sourceKey === "ops:stuck-story:s2")).toBe(false);
  });

  test("zero available models emits a critical provider-outage finding", () => {
    const out = mapModelFindings(modelHealth({ availableByCapability: { heavy: 0, medium: 0, light: 0 } }), NOW);
    const outage = out.find((f) => f.sourceKey === "ops:provider-outage")!;
    expect(outage).toBeDefined();
    expect(outage.severity).toBe("critical");
  });

  test("stale discovery (>6h) emits a low finding", () => {
    const out = mapModelFindings(modelHealth({ lastFullCheckAt: NOW - 8 * 60 * 60 * 1000 }), NOW);
    expect(out.some((f) => f.sourceKey === "ops:discovery-stale" && f.severity === "low")).toBe(true);
  });

  test("piling cooldowns and blocked models emit findings", () => {
    const out = mapModelFindings(modelHealth({ cooldownsActive: 6, qualitySummary: { blocked: 2, degraded: 0, probation: 0 } }), NOW);
    expect(out.some((f) => f.sourceKey === "ops:cooldowns-piling")).toBe(true);
    expect(out.some((f) => f.sourceKey === "ops:models-blocked")).toBe(true);
  });

  test("doctor error spike requires volume and a high error rate", () => {
    expect(mapDoctorFindings(doctorStats({ total: 20, success: 4 }), NOW)).toHaveLength(1);
    expect(mapDoctorFindings(doctorStats({ total: 20, success: 18 }), NOW)).toHaveLength(0);
    expect(mapDoctorFindings(doctorStats({ total: 4, success: 0 }), NOW)).toHaveLength(0);
  });

  test("stale and missing backups emit ops findings", () => {
    const stale = mapBackupFreshnessFindings({
      root: "/opt/backups",
      newestPath: "/opt/backups/2026-06-28",
      newestMtimeMs: NOW - 30 * 60 * 60 * 1000,
      ageMs: 30 * 60 * 60 * 1000,
      bucket: "stale",
    }, NOW)[0];
    expect(stale.sourceKey).toBe("ops:backup-stale");
    expect(stale.severity).toBe("medium");
    expect(stale.manualPageHref).toBe("/infra");

    const missing = mapBackupFreshnessFindings({
      root: "/opt/backups",
      newestPath: null,
      newestMtimeMs: null,
      ageMs: null,
      bucket: "missing",
    }, NOW)[0];
    expect(missing.severity).toBe("high");
  });

  test("large doctor log emits a rotate action", () => {
    const out = mapDoctorLogSizeFindings({ path: "/var/lib/mimule/doctor-log.jsonl", sizeBytes: 120 * 1024 * 1024, bucket: "huge" }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].sourceKey).toBe("ops:doctor-log-large");
    expect(out[0].severity).toBe("high");
    expect(out[0].actionDescriptorId).toBe("start-job:infra:doctor-log-rotate");
  });

  test("failed timers emit per-unit findings", () => {
    const out = mapFailedTimerFindings([{ unit: "model-health-check.timer", active: "failed", sub: "failed" }], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].sourceKey).toBe("ops:failed-timer:model-health-check.timer");
    expect(out[0].manualPageHref).toBe("/infra");
  });

  test("expired cooldown records emit auto-clear actions", () => {
    const out = mapStuckCooldownFindings([{ model: "editorial-heavy", expiresAt: NOW - 60_000, startedAt: NOW - 120_000, reason: "rate-limit" }], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].sourceKey).toBe("ops:cooldown-stuck:editorial-heavy");
    expect(out[0].actionDescriptorId).toBe("mutate-policy:model:editorial-heavy:cooldown-clear");
    expect(out[0].manualPageHref).toBe("/models");
  });

  test("aging approvals emit one governance finding", () => {
    const warn = mapApprovalAgingFindings([approval()], NOW)[0];
    expect(warn.sourceKey).toBe("ops:approvals-aging");
    expect(warn.severity).toBe("medium");
    expect(warn.manualPageHref).toBe("/governance");

    const critical = mapApprovalAgingFindings([approval({ requestedAt: NOW - 7 * 60 * 60 * 1000 })], NOW)[0];
    expect(critical.severity).toBe("high");
  });
});

describe("ops scanner: runOpsScan integration", () => {
  let tempDir: string;
  let prevDb: string | undefined;
  let prevDbPath: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "ops-scanner-test-"));
    prevDb = process.env.DASHBOARD_DB;
    prevDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    setOpsScanProbeOverridesForTest(null);
    closeDashboardDb();
    if (prevDb === undefined) delete process.env.DASHBOARD_DB; else process.env.DASHBOARD_DB = prevDb;
    if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH; else process.env.DASHBOARD_DB_PATH = prevDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("runs against the live host without throwing and persists any ops findings", () => {
    const result = runOpsScan();
    expect(Array.isArray(result.findings)).toBe(true);
    expect(typeof result.resolvedCount).toBe("number");
    for (const finding of result.findings) {
      expect(finding.domain).toBe("ops");
      expect(finding.sourceKey?.startsWith("ops:")).toBe(true);
      expect(getInsight(finding.id)).not.toBeNull();
    }
  });

  test("no-ops gracefully when the dashboard DB is closed", () => {
    closeDashboardDb();
    delete process.env.DASHBOARD_DB;
    const result = runOpsScan();
    expect(result.findings).toHaveLength(0);
    expect(result.resolvedCount).toBe(0);
  });

  test("new ops detectors persist findings and stale-resolve after triggers clear", () => {
    setOpsScanProbeOverridesForTest({
      ...neutralOpsOverrides(),
      getBackupFreshness: () => ({
        root: "/opt/backups",
        newestPath: null,
        newestMtimeMs: null,
        ageMs: null,
        bucket: "missing",
      }),
      getDoctorLogFinding: () => ({ path: "/var/lib/mimule/doctor-log.jsonl", sizeBytes: 75 * 1024 * 1024, bucket: "large" }),
      getFailedTimers: () => [{ unit: "sample-maintenance.timer", active: "failed", sub: "failed" }],
      getStuckCooldowns: () => [{ model: "editorial-heavy", expiresAt: Date.now() - 60_000, startedAt: Date.now() - 120_000, reason: "rate-limit" }],
      listPendingApprovals: () => [approval({ requestedAt: Date.now() - 2 * 60 * 60 * 1000 })],
    });

    const triggered = runOpsScan();
    expect(triggered.findings.some((f) => f.sourceKey === "ops:backup-stale")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "ops:doctor-log-large")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "ops:failed-timer:sample-maintenance.timer")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "ops:cooldown-stuck:editorial-heavy")).toBe(true);
    expect(triggered.findings.some((f) => f.sourceKey === "ops:approvals-aging")).toBe(true);

    setOpsScanProbeOverridesForTest(neutralOpsOverrides());
    const cleared = runOpsScan();
    expect(cleared.resolvedCount).toBeGreaterThanOrEqual(5);
    expect(getInsight("insight_ops_backup_stale")?.status).toBe("resolved");
    expect(getInsight("insight_ops_doctor_log_large")?.status).toBe("resolved");
    expect(getInsight("insight_ops_failed_timer_sample-maintenance.timer")?.status).toBe("resolved");
    expect(getInsight("insight_ops_cooldown_stuck_editorial-heavy")?.status).toBe("resolved");
    expect(getInsight("insight_ops_approvals_aging")?.status).toBe("resolved");
  });
});
