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
import {
  mapServiceFindings,
  mapHetznerFindings,
  mapGpuFindings,
  mapPipelineFindings,
  mapModelFindings,
  mapDoctorFindings,
  runOpsScan,
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

describe("ops scanner: pure mapping", () => {
  test("service down emits a high ops finding; critical service is critical", () => {
    const pills: ServicePill[] = [
      { name: "goblin_game", status: "inactive" },
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
});
