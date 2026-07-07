import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { createJob, readJob } from "../db/writer.ts";
import { riskTierFor, rollbackAffordanceForAction } from "../insights/autoapplyPolicy.ts";
import { buildActionCatalog } from "./actionDescriptors.ts";
import { runSingleModelProbe, setSingleModelProbeFetchForTests } from "./actions.ts";
import { executeActionHandler } from "./execute.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousHealthPath: string | undefined;
let previousLiteLLMKey: string | undefined;
let healthPath: string;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function seedHealth(): void {
  writeFileSync(healthPath, JSON.stringify({
    checkedAt: 1,
    checkedAtISO: "1970-01-01T00:00:00.001Z",
    models: [
      {
        logicalName: "editorial-heavy",
        provider: "local",
        testVia: "litellm",
        modelId: "editorial-heavy",
        capability: "heavy",
        available: false,
        latency: 999,
        error: "old error",
        checkedAt: 1,
        lastTestedAt: 1,
        jsonOk: false,
      },
    ],
  }, null, 2));
}

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "model-single-probe-"));
  healthPath = join(tempDir, "model-health.json");
  seedHealth();

  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  previousHealthPath = process.env.DASHBOARD_MODEL_HEALTH_PATH;
  previousLiteLLMKey = process.env.LITELLM_MASTER_KEY;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.DASHBOARD_MODEL_HEALTH_PATH = healthPath;
  process.env.LITELLM_MASTER_KEY = "test-key";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  setSingleModelProbeFetchForTests(null);
  restoreEnv("DASHBOARD_DB", previousDashboardDb);
  restoreEnv("DASHBOARD_DB_PATH", previousDashboardDbPath);
  restoreEnv("DASHBOARD_MODEL_HEALTH_PATH", previousHealthPath);
  restoreEnv("LITELLM_MASTER_KEY", previousLiteLLMKey);
  rmSync(tempDir, { recursive: true, force: true });
});

describe("probe:model:<logicalName>", () => {
  test("updates only the selected model row with a fallbacks-disabled LiteLLM probe", async () => {
    let requestBody: Record<string, unknown> | null = null;
    setSingleModelProbeFetchForTests(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "resolved-local-model",
        choices: [{ message: { content: "{\"status\":\"ok\"}" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    createJob({ id: "job-probe-1", kind: "model-single-probe", targetType: "model", targetId: "editorial-heavy", command: "probe", request: {} });
    await runSingleModelProbe("job-probe-1", "editorial-heavy", "operator reprobe");

    expect(requestBody?.model).toBe("editorial-heavy");
    expect(requestBody?.fallbacks).toEqual([]);

    const health = JSON.parse(readFileSync(healthPath, "utf8")) as {
      lastSingleProbeAt: number;
      models: Array<{ logicalName: string; available: boolean; error: string | null; jsonOk: boolean; resolvedModel: string }>;
    };
    expect(health.lastSingleProbeAt).toBeGreaterThan(1);
    expect(health.models[0]).toMatchObject({
      logicalName: "editorial-heavy",
      available: true,
      error: null,
      jsonOk: true,
      resolvedModel: "resolved-local-model",
    });

    const job = readJob("job-probe-1");
    expect(job?.status).toBe("success");
    expect(JSON.parse(job!.outputTail).logicalName).toBe("editorial-heavy");

    const audit = getDashboardDb()!.query(
      "SELECT action_kind, action_id, target_id, result_status, job_id FROM action_audit WHERE action_kind = ?",
    ).get("models.single-probe.finished") as { action_id: string; target_id: string; result_status: string; job_id: string };
    expect(audit.action_id).toBe("probe:model:editorial-heavy");
    expect(audit.target_id).toBe("editorial-heavy");
    expect(audit.result_status).toBe("success");
    expect(audit.job_id).toBe("job-probe-1");
  });

  test("catalog exposes probe descriptors as gated diagnostic actions", () => {
    const actions = buildActionCatalog({
      models: [
        {
          logicalName: "editorial-heavy",
          provider: "local",
          capability: "heavy",
          available: false,
          latency: null,
          jsonOk: false,
          checkedAt: 1,
          qualityStatus: "degraded",
          recentFailures: 1,
          consecutiveGarbage: 0,
          isFree: true,
          isPaid: false,
          isOpenCode: false,
          isCli: false,
          providerType: "local",
          contextWindow: 128000,
          params: 8,
          resolvedModel: "editorial-heavy",
        },
      ],
    });

    const probe = actions.find((action) => action.id === "probe:model:editorial-heavy");
    expect(probe?.kind).toBe("probe");
    expect(probe?.confirm).toBe(false);
    expect(probe?.reasonRequired).toBe(false);
    expect(probe?.jobKind).toBe("model-single-probe");
    expect(riskTierFor({ actionDescriptorId: probe?.id })).toBe("review");
    expect(rollbackAffordanceForAction(probe?.id)?.kind).toBe("read-only");
  });

  test("global executor starts a job without confirmation for probe:model actions", async () => {
    setSingleModelProbeFetchForTests(async () => new Response(JSON.stringify({
      model: "resolved-local-model",
      choices: [{ message: { content: "{\"status\":\"ok\"}" } }],
    }), { status: 200 }));

    const res = await executeActionHandler(new Request("http://127.0.0.1/api/actions/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId: "probe:model:editorial-heavy" }),
    }));
    const body = await res.json() as { ok: boolean; jobId: string; action: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("probe");
    expect(readJob(body.jobId)?.kind).toBe("model-single-probe");
  });
});
