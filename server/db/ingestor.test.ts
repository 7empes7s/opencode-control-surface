import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHomeData } from "../api/home.ts";
import type { HomeData } from "../api/types.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "./dashboard.ts";
import {
  parseTelegramChannelLogLine,
  setChannelLogReaderForTests,
  setBuildHomeDataForTests,
  setLiteLLMHealthProbeForTests,
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
    setLiteLLMHealthProbeForTests(async () => ({
      url: "http://127.0.0.1:4000",
      reachable: true,
      healthStatus: 200,
      healthOk: true,
      latencyMs: 1,
      authConfigured: false,
      authRequired: false,
      error: null,
    }));
    setChannelLogReaderForTests(async () => []);
  });

  afterEach(() => {
    controllerToStop?.stop();
    controllerToStop = null;
    closeDashboardDb();
    __resetSamplerStateForTests();
    setBuildHomeDataForTests(buildHomeData);
    setLiteLLMHealthProbeForTests(async () => ({
      url: "http://127.0.0.1:4000",
      reachable: true,
      healthStatus: 200,
      healthOk: true,
      latencyMs: 1,
      authConfigured: false,
      authRequired: false,
      error: null,
    }));
    setChannelLogReaderForTests(async () => []);

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
    setLiteLLMHealthProbeForTests(async () => ({
      url: "http://127.0.0.1:4000",
      reachable: true,
      healthStatus: 200,
      healthOk: true,
      latencyMs: 5,
      authConfigured: true,
      authRequired: false,
      error: null,
    }));

    const controller = startIngestor({ intervalMs: 10_000, litellmProbeIntervalMs: 1 });
    if (!controller) throw new Error("expected ingestor controller");
    controllerToStop = controller;

    await controller.tick();
    await controller.tick();

    const row = getDashboardDb()!.query("SELECT COUNT(*) AS count FROM metric_samples")
      .get() as { count: number };

    expect(row.count).toBeGreaterThan(0);

    const litellm = getDashboardDb()!.query(`
      SELECT value_json
      FROM metric_samples
      WHERE source = ? AND key = ?
      ORDER BY ts DESC
      LIMIT 1
    `).get("litellm", "health") as { value_json: string } | null;

    expect(JSON.parse(litellm?.value_json ?? "{}").healthOk).toBe(true);
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

  test("parses and ingests Telegram channel log lines once", async () => {
    openTempDb();
    setBuildHomeDataForTests(async () => ({ data: stubHome(), sources: {} }));
    setChannelLogReaderForTests(async () => [
      "2026-05-18T03:11:00Z openclaw_gateway telegram received callback_query story=abc token=secret123",
      "2026-05-18T03:11:01Z openclaw_gateway Telegram sent morning brief delivery ok",
      "2026-05-18T03:11:02Z openclaw_gateway health check ok",
    ]);

    const parsed = parseTelegramChannelLogLine("2026-05-18T03:11:00Z telegram received hello token=secret123", 1);
    expect(parsed?.direction).toBe("in");
    expect(parsed?.summary).toContain("token=[REDACTED]");

    const controller = startIngestor({
      intervalMs: 10_000,
      litellmProbeIntervalMs: 60_000,
      channelsProbeIntervalMs: 1,
    });
    if (!controller) throw new Error("expected ingestor controller");
    controllerToStop = controller;

    await controller.tick();
    await controller.tick();

    const rows = getDashboardDb()!.query(`
      SELECT direction, summary, payload_json
      FROM channels_log
      ORDER BY ts ASC
    `).all() as Array<{ direction: string; summary: string; payload_json: string }>;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.direction)).toEqual(["in", "out"]);
    expect(rows[0].summary).toContain("token=[REDACTED]");
    expect(JSON.parse(rows[0].payload_json).raw).toContain("token=[REDACTED]");
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
