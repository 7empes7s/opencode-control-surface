import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelsHandler } from "./models.ts";

let tempDir: string;
let previousHealthPath: string | undefined;
let previousQualityPath: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "models-api-"));
  previousHealthPath = process.env.DASHBOARD_MODEL_HEALTH_PATH;
  previousQualityPath = process.env.DASHBOARD_MODEL_QUALITY_PATH;
  process.env.DASHBOARD_MODEL_HEALTH_PATH = join(tempDir, "model-health.json");
  process.env.DASHBOARD_MODEL_QUALITY_PATH = join(tempDir, "model-quality.json");
});

afterEach(() => {
  if (previousHealthPath === undefined) delete process.env.DASHBOARD_MODEL_HEALTH_PATH;
  else process.env.DASHBOARD_MODEL_HEALTH_PATH = previousHealthPath;
  if (previousQualityPath === undefined) delete process.env.DASHBOARD_MODEL_QUALITY_PATH;
  else process.env.DASHBOARD_MODEL_QUALITY_PATH = previousQualityPath;
  rmSync(tempDir, { recursive: true, force: true });
});

test("modelsHandler reserves blocked for quality-policy blocks", async () => {
  writeFileSync(process.env.DASHBOARD_MODEL_HEALTH_PATH!, JSON.stringify({
    checkedAt: 1,
    lastFullCheckAt: 1,
    lastQuickCheckAt: 1,
    availableByCapability: { heavy: 0, medium: 0, light: 1 },
    models: [
      {
        logicalName: "rate-limited",
        provider: "openrouter",
        modelId: "provider/rate-limited",
        capability: "heavy",
        available: false,
        error: "HTTP 429",
      },
      {
        logicalName: "manual-block",
        provider: "groq",
        modelId: "provider/manual-block",
        capability: "light",
        available: true,
        latency: 50,
      },
      {
        logicalName: "probation",
        provider: "github",
        capability: "medium",
        available: true,
        error: "transient parse warning",
      },
    ],
  }));
  writeFileSync(process.env.DASHBOARD_MODEL_QUALITY_PATH!, JSON.stringify({
    models: {
      "provider/manual-block": { status: "blocked", recentFailures: [1, 2], consecutiveGarbage: 4 },
    },
  }));

  const res = modelsHandler();
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };
  const statuses = Object.fromEntries(body.data.models.map((model: any) => [model.logicalName, model.qualityStatus]));

  expect(statuses["rate-limited"]).toBe("degraded");
  expect(statuses["manual-block"]).toBe("blocked");
  expect(statuses["probation"]).toBe("probation");
  expect(body.data.summary.qualitySummary).toEqual({ blocked: 1, degraded: 1, probation: 1 });
  expect(body.data.models.find((model: any) => model.logicalName === "manual-block").recentFailures).toBe(2);
});
