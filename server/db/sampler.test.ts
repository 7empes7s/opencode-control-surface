import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeData } from "../api/types.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "./dashboard.ts";
import { __resetSamplerStateForTests, runHomeSampler } from "./sampler.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;

function registerSamplerTests(): void {
  beforeEach(() => {
    closeDashboardDb();
    __resetSamplerStateForTests();
    tempDir = mkdtempSync(join(tmpdir(), "dashboard-sampler-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  });

  afterEach(() => {
    closeDashboardDb();
    __resetSamplerStateForTests();

    if (previousDashboardDb === undefined) {
      delete process.env.DASHBOARD_DB;
    } else {
      process.env.DASHBOARD_DB = previousDashboardDb;
    }

    if (previousDashboardDbPath === undefined) {
      delete process.env.DASHBOARD_DB_PATH;
    } else {
      process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("no-op when DB disabled", () => {
    delete process.env.DASHBOARD_DB;
    closeDashboardDb();

    expect(() => runHomeSampler(stubHome())).not.toThrow();
    expect(getDashboardDb()).toBeNull();
  });

  test("metrics are not deduped", () => {
    openTempDb();

    runHomeSampler(stubHome());
    runHomeSampler(stubHome());

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM metric_samples
      WHERE source = ? AND key = ?
    `).get("gpu", "status") as { count: number };

    expect(row.count).toBeGreaterThanOrEqual(2);
  });

  test("transitions are deduped within a minute", () => {
    openTempDb();

    runHomeSampler(stubHome({ serviceStatus: "active" }));
    runHomeSampler(stubHome({ serviceStatus: "failed" }));
    runHomeSampler(stubHome({ serviceStatus: "failed" }));

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind = ? AND entity_type = ? AND entity_id = ?
    `).get("service.state", "service", "litellm") as { count: number };

    expect(row.count).toBe(1);
  });

  test("service transition emits one event", () => {
    openTempDb();

    runHomeSampler(stubHome({ serviceStatus: "active" }));
    runHomeSampler(stubHome({ serviceStatus: "failed" }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary
      FROM events
      WHERE kind = ?
    `).all("service.state") as Array<{ kind: string; severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("active → failed");
  });

  test("GPU down emits error", () => {
    openTempDb();

    runHomeSampler(stubHome({ gpuStatus: "up" }));
    runHomeSampler(stubHome({ gpuStatus: "down" }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity
      FROM events
      WHERE kind = ?
    `).all("gpu.status") as Array<{ kind: string; severity: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
  });

  test("first call seeds and does not emit", () => {
    openTempDb();
    __resetSamplerStateForTests();

    runHomeSampler(stubHome());

    const events = getDashboardDb()!.query("SELECT COUNT(*) AS count FROM events").get() as { count: number };
    const samples = getDashboardDb()!.query("SELECT COUNT(*) AS count FROM metric_samples").get() as { count: number };

    expect(events.count).toBe(0);
    expect(samples.count).toBeGreaterThan(0);
  });

  test("disk bucket transition emits one event", () => {
    openTempDb();

    runHomeSampler(stubHome({ diskUsedPct: 50 }));
    runHomeSampler(stubHome({ diskUsedPct: 90 }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary
      FROM events
      WHERE kind = ?
    `).all("disk.bucket") as Array<{ kind: string; severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("%");
  });

  test("disk staying within same bucket emits no event", () => {
    openTempDb();

    runHomeSampler(stubHome({ diskUsedPct: 75 }));
    runHomeSampler(stubHome({ diskUsedPct: 78 }));

    const row = getDashboardDb()!.query(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE kind = ?
    `).get("disk.bucket") as { count: number };

    expect(row.count).toBe(0);
  });

  test("doctor decision transition emits an event", () => {
    openTempDb();

    runHomeSampler(stubHome({
      doctorLastDecision: { ts: "2026-05-10T10:00:00.000Z", slug: "story-a", action: "retry", reason: "first" },
    }));
    runHomeSampler(stubHome({
      doctorLastDecision: { ts: "2026-05-10T10:01:00.000Z", slug: "story-a", action: "kill", reason: "failed" },
    }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, entity_id, summary
      FROM events
      WHERE kind = ?
    `).all("doctor.decision") as Array<{ kind: string; severity: string; entity_id: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].entity_id).toBe("story-a");
    expect(rows[0].summary).toContain("kill");
  });

  test("doctor rate-limit increase emits a warning event", () => {
    openTempDb();

    runHomeSampler(stubHome({ doctorErrorClasses: [] }));
    runHomeSampler(stubHome({ doctorErrorClasses: [{ type: "rate_limit", count: 3 }] }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary
      FROM events
      WHERE kind = ?
    `).all("doctor.rate_limit") as Array<{ kind: string; severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].summary).toContain("0 → 3");
  });

  test("doctor quota increase emits an error event", () => {
    openTempDb();

    runHomeSampler(stubHome({ doctorErrorClasses: [] }));
    runHomeSampler(stubHome({ doctorErrorClasses: [{ type: "quota", count: 2 }] }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary
      FROM events
      WHERE kind = ?
    `).all("doctor.quota") as Array<{ kind: string; severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("0 → 2");
  });

  test("approval backlog emits a queue-health warning event", () => {
    openTempDb();

    runHomeSampler(stubHome({ approvalsWaiting: 0, queueDepth: 4, oldestApprovalAgeMs: null }));
    runHomeSampler(stubHome({ approvalsWaiting: 12, queueDepth: 14, oldestApprovalAgeMs: 30 * 60 * 1000 }));

    const rows = getDashboardDb()!.query(`
      SELECT kind, severity, summary, payload_json
      FROM events
      WHERE kind = ?
    `).all("pipeline.queue_health") as Array<{ kind: string; severity: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warn");
    expect(rows[0].summary).toContain("approval-warn");
    expect(JSON.parse(rows[0].payload_json).approvalsWaiting).toBe(12);
  });

  test("old approval emits a critical queue-health event", () => {
    openTempDb();

    runHomeSampler(stubHome({ approvalsWaiting: 1, queueDepth: 2, oldestApprovalAgeMs: 20 * 60 * 1000 }));
    runHomeSampler(stubHome({ approvalsWaiting: 1, queueDepth: 2, oldestApprovalAgeMs: 7 * 60 * 60 * 1000 }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, summary
      FROM events
      WHERE kind = ?
    `).all("pipeline.queue_health") as Array<{ severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("approval-critical");
    expect(rows[0].summary).toContain("7h");
  });

  test("paused queue emits a queue-health error event", () => {
    openTempDb();

    runHomeSampler(stubHome({ approvalsWaiting: 0, queueDepth: 2, paused: false }));
    runHomeSampler(stubHome({ approvalsWaiting: 0, queueDepth: 2, paused: true }));

    const rows = getDashboardDb()!.query(`
      SELECT severity, summary
      FROM events
      WHERE kind = ?
    `).all("pipeline.queue_health") as Array<{ severity: string; summary: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].summary).toContain("paused-with-queue");
  });
}

function openTempDb(): void {
  process.env.DASHBOARD_DB = "1";
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
}

function stubHome(overrides: {
  serviceStatus?: HomeData["services"][number]["status"];
  gpuStatus?: HomeData["gpu"]["status"];
  runwayHours?: number | null;
  qualitySummary?: HomeData["models"]["qualitySummary"];
  diskUsedPct?: number;
  doctorLastDecision?: HomeData["doctor"]["lastDecision"];
  doctorErrorClasses?: HomeData["doctor"]["last24h"]["errorClasses"];
  queueDepth?: number;
  approvalsWaiting?: number;
  oldestApprovalAgeMs?: number | null;
  paused?: boolean;
} = {}): HomeData {
  const queueDepth = overrides.queueDepth ?? 2;
  const approvalsWaiting = overrides.approvalsWaiting ?? 1;
  const stageBreakdown = approvalsWaiting > 0
    ? { draft: Math.max(queueDepth - approvalsWaiting, 0), publish: approvalsWaiting }
    : { draft: queueDepth };

  return {
    services: [
      { name: "litellm", status: overrides.serviceStatus ?? "active" },
    ],
    gpu: {
      status: overrides.gpuStatus ?? "up",
      gpuUtil: 42,
      loadedModels: ["model-a"],
      probeMs: 12,
      checkedAgo: 3,
    },
    vast: {
      balance: 20,
      credit: 0,
      hourlyRate: 1,
      runwayHours: overrides.runwayHours ?? 20,
      instanceStatus: "running",
      gpu: "RTX 3090",
    },
    hetzner: {
      load1: 0.1,
      load5: 0.2,
      load15: 0.3,
      memUsedPct: 50,
      diskUsedPct: overrides.diskUsedPct ?? 60,
    },
    newsbites: {
      totalPublished: 10,
      publishedToday: 1,
      publishedLast7d: [0, 0, 0, 0, 0, 0, 1],
      topVerticals: [],
      latestArticles: [],
      siteReachable: true,
    },
    autopipeline: {
      queueDepth,
      approvalsWaiting,
      oldestApprovalAgeMs: overrides.oldestApprovalAgeMs === undefined ? 5000 : overrides.oldestApprovalAgeMs,
      currentStory: null,
      paused: overrides.paused ?? false,
      pauseReason: null,
      stageBreakdown,
    },
    doctor: {
      last24h: {
        total: overrides.doctorErrorClasses?.reduce((sum, entry) => sum + entry.count, 0) ?? 0,
        success: 0,
        errorClasses: overrides.doctorErrorClasses ?? [],
        topFailingModels: [],
        topFailingStages: [],
        verdictMix: [],
      },
      lastDecision: overrides.doctorLastDecision ?? null,
    },
    models: {
      bestLocal: null,
      bestCloudHeavy: null,
      bestCloudFast: null,
      availableByCapability: { heavy: 1, medium: 1, light: 1 },
      qualitySummary: overrides.qualitySummary ?? { blocked: 0, degraded: 0, probation: 0 },
      newModelsAdded: [],
      lastFullCheckAgo: 60,
      lastQuickCheckAgo: 30,
      cooldownsActive: 0,
      soonestCooldownExpiresMs: null,
    },
    incidents: {
      activeCount: 0,
      recentAlerts: [],
    },
  };
}

try {
  registerSamplerTests();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (import.meta.main && message.includes("outside of the test runner")) {
    const result = Bun.spawnSync(["bun", "test", new URL(import.meta.url).pathname], {
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(result.exitCode);
  }

  throw error;
}
