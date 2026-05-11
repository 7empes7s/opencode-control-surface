import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { writeMetricSample } from "../db/writer.ts";
import type { ApiEnvelope } from "./types.ts";
import { metricsHandler, type MetricsResponse } from "./metrics.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;

function registerMetricsTests(): void {
  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "dashboard-metrics-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  });

  afterEach(() => {
    closeDashboardDb();

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

  test("returns degraded when DB disabled", async () => {
    delete process.env.DASHBOARD_DB;
    closeDashboardDb();

    const data = await readMetrics("/api/metrics");

    expect(data.samples).toEqual([]);
    expect(data.rollup).toEqual([]);
    expect(data.degraded).toBe(true);
  });

  test("returns samples with filters", async () => {
    openTempDb();
    for (let index = 0; index < 5; index += 1) {
      writeMetricSample({ source: "services", key: "litellm.state", value: { state: "active", index } });
    }

    const data = await readMetrics("/api/metrics");

    expect(data.samples).toHaveLength(5);
    expect(data.rollup.length).toBeGreaterThan(0);
    expect(data.degraded).toBe(false);
  });

  test("source filter narrows results", async () => {
    openTempDb();
    writeMetricSample({ source: "services", key: "litellm.state", value: { state: "active" } });
    writeMetricSample({ source: "gpu", key: "status", value: { status: "up" } });

    const data = await readMetrics("/api/metrics?source=services");

    expect(data.samples).toHaveLength(1);
    expect(data.samples[0].source).toBe("services");
    expect(data.rollup).toHaveLength(1);
    expect(data.rollup[0].source).toBe("services");
  });

  test("limit clamps", async () => {
    openTempDb();
    for (let index = 0; index < 1500; index += 1) {
      writeMetricSample({ source: "bulk", key: "sample", value: { index } });
    }

    const data = await readMetrics("/api/metrics?limit=99999");

    expect(data.samples).toHaveLength(1000);
  });

  test("rollup aggregates numeric field values", async () => {
    openTempDb();
    writeMetricSample({ source: "vast", key: "runway", value: { runwayHours: 6, balance: 12 } });
    writeMetricSample({ source: "vast", key: "runway", value: { runwayHours: 2, balance: 4 } });
    writeMetricSample({ source: "vast", key: "runway", value: { runwayHours: 10, balance: 20 } });

    const data = await readMetrics("/api/metrics?source=vast&key=runway&field=runwayHours");
    const rollup = data.rollup[0];

    expect(rollup.count).toBe(3);
    expect(rollup.field).toBe("runwayHours");
    expect(rollup.min).toBe(2);
    expect(rollup.max).toBe(10);
    expect(rollup.avg).toBe(6);
    expect(rollup.sum).toBe(18);
    expect(rollup.numericCount).toBe(3);
  });

  test("rollup aggregates dotted numeric field values", async () => {
    openTempDb();
    writeMetricSample({
      source: "pipeline",
      key: "queue",
      value: { stageBreakdown: { research: 3, approval: 1 }, total: 4 },
    });
    writeMetricSample({
      source: "pipeline",
      key: "queue",
      value: { stageBreakdown: { research: 7, approval: 2 }, total: 9 },
    });
    writeMetricSample({
      source: "pipeline",
      key: "queue",
      value: { stageBreakdown: { research: 5, approval: 0 }, total: 5 },
    });

    const data = await readMetrics(
      "/api/metrics?source=pipeline&key=queue&field=stageBreakdown.research",
    );
    const rollup = data.rollup[0];

    expect(rollup.count).toBe(3);
    expect(rollup.field).toBe("stageBreakdown.research");
    expect(rollup.min).toBe(3);
    expect(rollup.max).toBe(7);
    expect(rollup.avg).toBe(5);
    expect(rollup.sum).toBe(15);
    expect(rollup.numericCount).toBe(3);
  });

  test("rollup omits numeric fields when requested field is missing or non-numeric", async () => {
    openTempDb();
    writeMetricSample({ source: "gpu", key: "status", value: { status: "up" } });
    writeMetricSample({ source: "gpu", key: "status", value: { util: "busy" } });
    writeMetricSample({ source: "gpu", key: "status", value: { util: null } });

    const data = await readMetrics("/api/metrics?source=gpu&key=status&field=util");
    const rollup = data.rollup[0];

    expect(rollup.count).toBe(3);
    expect(typeof rollup.latestTs).toBe("number");
    expect(rollup.latestValue).toBeDefined();
    expect(rollup.min).toBeUndefined();
    expect(rollup.max).toBeUndefined();
    expect(rollup.avg).toBeUndefined();
    expect(rollup.sum).toBeUndefined();
    expect(rollup.numericCount).toBeUndefined();
  });
}

function openTempDb(): void {
  process.env.DASHBOARD_DB = "1";
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
}

async function readMetrics(path: string): Promise<MetricsResponse> {
  const response = await metricsHandler(new URL(path, "http://localhost"));
  const envelope = await response.json() as ApiEnvelope<MetricsResponse>;
  return envelope.data;
}

try {
  registerMetricsTests();
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
