import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHomeData } from "../api/home.ts";
import type { HomeData } from "../api/types.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "./dashboard.ts";
import {
  setBuildHomeDataForTests,
  startIngestor,
  type IngestorController,
} from "./ingestor.ts";
import { __resetSamplerStateForTests } from "./sampler.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let controllerToStop: IngestorController | null = null;

function registerIngestorTests(): void {
  beforeEach(() => {
    closeDashboardDb();
    __resetSamplerStateForTests();
    tempDir = mkdtempSync(join(tmpdir(), "dashboard-ingestor-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  });

  afterEach(() => {
    controllerToStop?.stop();
    controllerToStop = null;
    closeDashboardDb();
    __resetSamplerStateForTests();
    setBuildHomeDataForTests(buildHomeData);

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

  test("ingestor returns null when DB disabled", () => {
    closeDashboardDb();
    delete process.env.DASHBOARD_DB;

    const controller = startIngestor({ intervalMs: 50 });

    expect(controller).toBeNull();
  });

  test("manual tick writes through sampler", async () => {
    openTempDb();
    setBuildHomeDataForTests(async () => ({ data: stubHome(), sources: {} }));

    const controller = startIngestor({ intervalMs: 10_000 });
    if (!controller) throw new Error("expected ingestor controller");
    controllerToStop = controller;

    await controller.tick();
    await controller.tick();

    const row = getDashboardDb()!.query("SELECT COUNT(*) AS count FROM metric_samples")
      .get() as { count: number };

    expect(row.count).toBeGreaterThan(0);
    controller.stop();
    controller.stop();
  });

  test("interval fires automatically", async () => {
    openTempDb();
    setBuildHomeDataForTests(async () => ({ data: stubHome(), sources: {} }));

    const controller = startIngestor({ intervalMs: 30 });
    if (!controller) throw new Error("expected ingestor controller");
    controllerToStop = controller;

    await new Promise((resolve) => setTimeout(resolve, 100));

    const row = getDashboardDb()!.query("SELECT COUNT(*) AS count FROM metric_samples")
      .get() as { count: number };

    expect(row.count).toBeGreaterThan(0);
    controller.stop();
  });
}

function openTempDb(): void {
  process.env.DASHBOARD_DB = "1";
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
}

function stubHome(): HomeData {
  return {
    services: [{ name: "litellm", status: "active" }],
    gpu: {
      status: "up",
      gpuUtil: 42,
      loadedModels: ["model-a"],
      probeMs: 12,
      checkedAgo: 3,
    },
    vast: {
      balance: 20,
      credit: 0,
      hourlyRate: 1,
      runwayHours: 20,
      instanceStatus: "running",
      gpu: "RTX 3090",
    },
    hetzner: {
      load1: 0.1,
      load5: 0.2,
      load15: 0.3,
      memUsedPct: 50,
      diskUsedPct: 60,
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
      queueDepth: 2,
      approvalsWaiting: 1,
      oldestApprovalAgeMs: 5000,
      currentStory: null,
      paused: false,
      pauseReason: null,
      stageBreakdown: { draft: 1, approval: 1 },
    },
    doctor: {
      last24h: {
        total: 0,
        success: 0,
        errorClasses: [],
        topFailingModels: [],
        topFailingStages: [],
        verdictMix: [],
      },
      lastDecision: null,
    },
    models: {
      bestLocal: null,
      bestCloudHeavy: null,
      bestCloudFast: null,
      availableByCapability: { heavy: 1, medium: 1, light: 1 },
      qualitySummary: { blocked: 0, degraded: 0, probation: 0 },
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
  registerIngestorTests();
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
