import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { createApprovalRequest, submitVote } from "../governance/approvals.ts";
import { handleApi } from "./router.ts";
import { modelLifecycleHandler, modelsHandler } from "./models.ts";

let tempDir: string;
let previousHealthPath: string | undefined;
let previousQualityPath: string | undefined;
let previousReprobeStatePath: string | undefined;
let previousCredentialHealthPath: string | undefined;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousOperatorToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "models-api-"));
  previousHealthPath = process.env.DASHBOARD_MODEL_HEALTH_PATH;
  previousQualityPath = process.env.DASHBOARD_MODEL_QUALITY_PATH;
  previousReprobeStatePath = process.env.DASHBOARD_REPROBE_STATE_PATH;
  previousCredentialHealthPath = process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH;
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  previousOperatorToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_MODEL_HEALTH_PATH = join(tempDir, "model-health.json");
  process.env.DASHBOARD_MODEL_QUALITY_PATH = join(tempDir, "model-quality.json");
  process.env.DASHBOARD_REPROBE_STATE_PATH = join(tempDir, "model-fallback-reprobe.json");
  process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH = join(tempDir, "credential-health.json");
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (previousHealthPath === undefined) delete process.env.DASHBOARD_MODEL_HEALTH_PATH;
  else process.env.DASHBOARD_MODEL_HEALTH_PATH = previousHealthPath;
  if (previousQualityPath === undefined) delete process.env.DASHBOARD_MODEL_QUALITY_PATH;
  else process.env.DASHBOARD_MODEL_QUALITY_PATH = previousQualityPath;
  if (previousReprobeStatePath === undefined) delete process.env.DASHBOARD_REPROBE_STATE_PATH;
  else process.env.DASHBOARD_REPROBE_STATE_PATH = previousReprobeStatePath;
  if (previousCredentialHealthPath === undefined) delete process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH;
  else process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH = previousCredentialHealthPath;
  if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDashboardDb;
  if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
  if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousOperatorToken;
  rmSync(tempDir, { recursive: true, force: true });
});

function writeHealth(logicalName = "candidate-model"): void {
  writeFileSync(process.env.DASHBOARD_MODEL_HEALTH_PATH!, JSON.stringify({
    checkedAt: 1,
    lastFullCheckAt: 1,
    lastQuickCheckAt: 1,
    availableByCapability: { heavy: 1, medium: 0, light: 0 },
    models: [
      {
        logicalName,
        provider: "test-provider",
        modelId: `provider/${logicalName}`,
        capability: "heavy",
        available: true,
        latency: 50,
      },
    ],
  }));
}

function writeQuality(logicalName = "candidate-model", entry: Record<string, unknown> = { status: "healthy", recentFailures: 0, consecutiveGarbage: 0 }): void {
  writeFileSync(process.env.DASHBOARD_MODEL_QUALITY_PATH!, JSON.stringify({
    models: {
      [`provider/${logicalName}`]: entry,
    },
  }));
}

function writeCredentialHealth(input: {
  envName: string;
  provider: string;
  status: string;
  httpCode: number | null;
  gatesModels: string[];
  present?: boolean;
  generatedAt?: number;
  expiresAt?: number;
  rawSentinel?: string;
}): void {
  const now = Date.now();
  writeFileSync(process.env.DASHBOARD_CREDENTIAL_HEALTH_PATH!, JSON.stringify({
    schemaVersion: 1,
    policyVersion: "credential-observation-v1",
    runId: "models-api-test-run",
    generatedAt: input.generatedAt ?? now - 1_000,
    expiresAt: input.expiresAt ?? now + 60 * 60 * 1000,
    credentials: {
      [input.envName]: {
        provider: input.provider,
        status: input.status,
        httpCode: input.httpCode,
        checkedAt: now - 2_000,
        sinceStatus: now - 3_000,
        gatesModels: input.gatesModels,
        present: input.present ?? input.status !== "missing",
        secretValue: input.rawSentinel,
        providerBody: input.rawSentinel,
      },
    },
    rawSentinel: input.rawSentinel,
  }), { mode: 0o600 });
}

function seedEval(logicalName: string, ts: number, value: Record<string, unknown>): void {
  getDashboardDb()!.query(`
    INSERT INTO metric_samples (ts, source, key, value_json, tenant_id)
    VALUES (?, 'model-eval', ?, ?, ?)
  `).run(ts, logicalName, JSON.stringify({ ts, ...value }), "mimule");
}

function seedGatewayCall(input: {
  ts?: number;
  logicalModel?: string;
  resolvedModel: string;
  backend?: string;
  success: 0 | 1;
  errorClass?: string | null;
  latencyMs?: number | null;
}): void {
  getDashboardDb()!.query(`
    INSERT INTO gateway_calls
      (ts, logical_model, resolved_model, backend, tier, success, error_class, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.ts ?? Date.now(),
    input.logicalModel ?? "test-logical-model",
    input.resolvedModel,
    input.backend ?? "litellm",
    "cloud-free",
    input.success,
    input.errorClass ?? null,
    input.latencyMs ?? null,
  );
}

test("modelsHandler returns a reprobe and ledger route absent from model-health as degraded", async () => {
  const logicalName = "coding-go-minimax-m3";
  const rawSentinel = "DO_NOT_EXPOSE_RAW_CREDENTIAL";
  writeHealth("health-roster-model");
  writeFileSync(process.env.DASHBOARD_REPROBE_STATE_PATH!, JSON.stringify({
    history: {
      [logicalName]: { code: 402, streak: 7, since: 1_784_312_381, ms: 849 },
    },
  }));
  const oldTs = Date.now() - 8 * 86400 * 1000;

  for (let i = 0; i < 425; i += 1) {
    seedGatewayCall({ ts: oldTs, resolvedModel: logicalName, success: 1 });
  }
  for (let i = 0; i < 91; i += 1) {
    seedGatewayCall({ ts: oldTs, resolvedModel: logicalName, success: 0, errorClass: "other" });
  }
  for (let i = 0; i < 10; i += 1) {
    seedGatewayCall({ resolvedModel: logicalName, success: 0, errorClass: "auth" });
  }
  writeCredentialHealth({
    envName: "OPENCODE_GO_API_KEY",
    provider: "opencode-go",
    status: "expired",
    httpCode: 401,
    gatesModels: [logicalName],
    rawSentinel,
  });

  const res = modelsHandler();
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };
  const model = body.data.models.find((candidate: any) => candidate.logicalName === logicalName);

  expect(model).toMatchObject({
    logicalName,
    provider: "unknown",
    capability: "unknown",
    available: false,
    qualityStatus: "unknown",
    resolvedModel: logicalName,
  });
  expect(model.healthState).toBe("degraded");
  expect(model.healthBucket).toBe("unhealthy");
  expect(model.healthReason).toContain("OPENCODE_GO_API_KEY) is expired");
  expect(model.healthReason).toContain("not proof the model is dead");
  expect(model.credentialBlocked).toBe(true);
  expect(model.credentialHealth).toEqual({
    envName: "OPENCODE_GO_API_KEY",
    provider: "opencode-go",
    status: "expired",
    httpCode: 401,
    checkedAt: expect.any(Number),
    sinceStatus: expect.any(Number),
    gatesModels: [logicalName],
    present: true,
    fresh: true,
  });
  expect(body.data.credentials).toEqual([model.credentialHealth]);
  expect(body.data.models.find((candidate: any) => candidate.logicalName === "health-roster-model").credentialHealth).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain(rawSentinel);
  expect(body.data.models.every((candidate: any) => (
    typeof candidate.healthState === "string"
    && typeof candidate.healthBucket === "string"
    && typeof candidate.healthReason === "string"
    && candidate.healthReason.length > 0
  ))).toBe(true);
  expect(body.data.summary.healthStateSummary).toEqual({
    live: 0,
    limited: 0,
    slow: 0,
    degraded: 1,
    dead: 0,
    hang: 0,
    unknown: 1,
  });
  expect(body.data.summary.healthBucketSummary).toEqual({ healthy: 0, unhealthy: 1, unknown: 1 });
});

test("modelsHandler ignores stale credential files without changing model state", async () => {
  const logicalName = "stale-credential-route";
  writeHealth(logicalName);
  writeFileSync(process.env.DASHBOARD_REPROBE_STATE_PATH!, JSON.stringify({
    history: { [logicalName]: { code: 200, streak: 0, ms: 100 } },
  }));
  writeCredentialHealth({
    envName: "STALE_API_KEY",
    provider: "test-provider",
    status: "expired",
    httpCode: 401,
    gatesModels: [logicalName],
    generatedAt: Date.now() - 14 * 60 * 60 * 1000,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  const body = await modelsHandler().json() as { data: any };
  expect(body.data.credentials).toEqual([]);
  expect(body.data.models[0].healthState).toBe("live");
  expect(body.data.models[0].credentialHealth).toBeUndefined();
  expect(body.data.models[0].credentialBlocked).toBeUndefined();
});

test("modelsHandler appends observed-only routes deterministically without duplicates", async () => {
  writeFileSync(process.env.DASHBOARD_MODEL_HEALTH_PATH!, JSON.stringify({
    models: [
      { logicalName: "health-z", provider: "test", available: true },
      { logicalName: "health-a", provider: "test", available: false },
    ],
  }));
  writeFileSync(process.env.DASHBOARD_REPROBE_STATE_PATH!, JSON.stringify({
    history: {
      "reprobe-z": { code: 500, streak: 1, since: 100, ms: 20 },
      "health-a": { code: 500, streak: 1, since: 100, ms: 20 },
      "reprobe-a": { code: 500, streak: 1, since: 100, ms: 20 },
    },
  }));
  seedGatewayCall({ resolvedModel: "ledger-b", success: 1 });
  seedGatewayCall({ resolvedModel: "health-a", success: 1 });

  const res = modelsHandler();
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };

  expect(body.data.models.map((model: any) => model.logicalName)).toEqual([
    "health-z",
    "health-a",
    "ledger-b",
    "reprobe-a",
    "reprobe-z",
  ]);
  expect(body.data.models.filter((model: any) => model.logicalName === "health-a")).toHaveLength(1);
  expect(body.data.models.find((model: any) => model.logicalName === "ledger-b")).toMatchObject({
    provider: "unknown",
    available: false,
    qualityStatus: "unknown",
    healthState: "live",
    healthBucket: "healthy",
  });
  expect(body.data.models.find((model: any) => model.logicalName === "reprobe-z")).toMatchObject({
    provider: "unknown",
    healthState: "unknown",
  });
});

test("modelsHandler prefers resolved or modelId ledger evidence and does not duplicate its key", async () => {
  const logicalName = "alias-model";
  const modelId = `provider/${logicalName}`;
  writeHealth(logicalName);
  for (let i = 0; i < 3; i += 1) {
    seedGatewayCall({ resolvedModel: modelId, success: 1, latencyMs: 100 });
  }
  for (let i = 0; i < 20; i += 1) {
    seedGatewayCall({ resolvedModel: logicalName, success: 0, errorClass: "other" });
  }

  const res = modelsHandler();
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };

  expect(body.data.models.map((model: any) => model.logicalName)).toEqual([logicalName]);
  expect(body.data.models[0]).toMatchObject({
    resolvedModel: modelId,
    healthState: "live",
    healthBucket: "healthy",
  });
  expect(body.data.models[0].healthReason).toContain("3/3");
});

test("modelsHandler excludes cli-direct rows from health classification", async () => {
  const logicalName = "cli-only-model";
  writeHealth(logicalName);
  for (let i = 0; i < 3; i += 1) {
    seedGatewayCall({ resolvedModel: logicalName, backend: "cli-direct", success: 1 });
  }

  const res = modelsHandler();
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };
  const model = body.data.models.find((candidate: any) => candidate.logicalName === logicalName);

  expect(model.healthState).toBe("unknown");
});

test("modelsHandler excludes gateway_unreachable rows from health classification", async () => {
  const logicalName = "gateway-bounce-model";
  writeHealth(logicalName);
  for (let i = 0; i < 20; i += 1) {
    seedGatewayCall({ resolvedModel: logicalName, success: 0, errorClass: "gateway_unreachable" });
  }

  const res = modelsHandler();
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };
  const model = body.data.models.find((candidate: any) => candidate.logicalName === logicalName);

  expect(model.healthState).toBe("unknown");
});

test("modelsHandler returns unknown health on a fresh host without reprobe or ledger evidence", async () => {
  writeFileSync(process.env.DASHBOARD_MODEL_HEALTH_PATH!, JSON.stringify({
    models: [
      { logicalName: "fresh-a", provider: "test", available: true },
      { logicalName: "fresh-b", provider: "test", available: false },
    ],
  }));
  closeDashboardDb();
  process.env.DASHBOARD_DB = "0";

  const res = modelsHandler();
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };

  expect(body.data.models.map((model: any) => model.healthState)).toEqual(["unknown", "unknown"]);
  expect(body.data.models.map((model: any) => model.healthBucket)).toEqual(["unknown", "unknown"]);
  expect(body.data.models.every((model: any) => model.healthReason.includes("no probe entry and no ledger calls"))).toBe(true);
  expect(body.data.summary.healthStateSummary).toEqual({
    live: 0,
    limited: 0,
    slow: 0,
    degraded: 0,
    dead: 0,
    hang: 0,
    unknown: 2,
  });
  expect(body.data.summary.healthBucketSummary).toEqual({ healthy: 0, unhealthy: 0, unknown: 2 });
});

test("modelsHandler skips malformed health and reprobe entries without returning a 500", async () => {
  writeFileSync(process.env.DASHBOARD_MODEL_HEALTH_PATH!, JSON.stringify({
    models: [null, "bad-row", { logicalName: "valid-row", provider: "test", available: true }],
  }));
  writeFileSync(process.env.DASHBOARD_REPROBE_STATE_PATH!, JSON.stringify({
    history: {
      "bad-route": "not-an-entry",
      "valid-row": { code: "200", ms: Number.NaN, streak: -1 },
    },
  }));
  closeDashboardDb();
  process.env.DASHBOARD_DB = "0";

  const res = modelsHandler();
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };
  expect(body.data.models.map((model: any) => model.logicalName)).toEqual(["valid-row"]);
  expect(body.data.models[0]).toMatchObject({
    healthState: "unknown",
    healthBucket: "unknown",
  });
});

async function readRoutingReliability(logicalName: string): Promise<any> {
  const res = modelLifecycleHandler(logicalName);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { routingReliability: any } };
  return body.data.routingReliability;
}

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

test("modelLifecycleHandler returns real model-eval history and needs approval when checks pass", async () => {
  writeHealth("candidate-model");
  writeQuality("candidate-model");
  seedEval("candidate-model", 1000, { score: 0.8, latencyMs: 120, error: null });
  seedEval("candidate-model", 2000, { score: 0.92, latencyMs: 90, error: null });

  const res = modelLifecycleHandler("candidate-model");
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };
  expect(body.data.evalHistory).toEqual([
    { ts: 1000, score: 0.8, latencyMs: 120, error: null },
    { ts: 2000, score: 0.92, latencyMs: 90, error: null },
  ]);
  expect(body.data.firstSeen).toBe(1000);
  expect(body.data.lastEval).toBe(2000);
  expect(body.data.qualityStatus).toBe("healthy");
  expect(body.data.promotionReadiness.gate).toBe("needs-approval");
  expect(body.data.promotionReadiness.reasons).toContain("latest eval score 0.92 meets required 0.75");
  expect(body.data.promotionReadiness.reasons).toContain("promotion approval is required");
});

test("modelLifecycleHandler blocks promotion when eval history is empty", async () => {
  writeHealth("new-model");
  writeQuality("new-model");

  const res = modelLifecycleHandler("new-model");
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };
  expect(body.data.evalHistory).toEqual([]);
  expect(body.data.promotionReadiness.gate).toBe("blocked");
  expect(body.data.promotionReadiness.reasons).toContain("insufficient eval history");
});

test("modelLifecycleHandler reads fallback-target routing reliability from the gateway ledger", async () => {
  const resolvedModel = "groq-openai-gpt-oss-120b";
  seedGatewayCall({ resolvedModel, success: 1 });
  for (let i = 0; i < 67; i += 1) {
    seedGatewayCall({ resolvedModel, success: 0 });
  }

  const routingReliability = await readRoutingReliability(resolvedModel);
  expect(routingReliability).toMatchObject({
    totalRequests: 68,
    successCount: 1,
    fallbackCount: 0,
    failedCount: 67,
  });
});

test("modelLifecycleHandler attributes routing reliability by resolved_model", async () => {
  seedGatewayCall({ logicalModel: "request-route", resolvedModel: "editorial-heavy", success: 1 });
  seedGatewayCall({ logicalModel: "editorial-heavy", resolvedModel: "fallback-target", success: 0 });

  const routingReliability = await readRoutingReliability("editorial-heavy");
  expect(routingReliability).toMatchObject({
    totalRequests: 1,
    successCount: 1,
    failedCount: 0,
  });
});

test("modelLifecycleHandler excludes cli-direct accounting rows from routing reliability", async () => {
  seedGatewayCall({ resolvedModel: "candidate-model", backend: "litellm", success: 1 });
  seedGatewayCall({ resolvedModel: "candidate-model", backend: "cli-direct", success: 0 });

  const routingReliability = await readRoutingReliability("candidate-model");
  expect(routingReliability).toMatchObject({
    totalRequests: 1,
    successCount: 1,
    failedCount: 0,
  });
});

test("modelLifecycleHandler excludes gateway_unreachable rows from routing reliability", async () => {
  seedGatewayCall({ resolvedModel: "candidate-model", success: 1 });
  seedGatewayCall({ resolvedModel: "candidate-model", success: 0, errorClass: "gateway_unreachable" });

  const routingReliability = await readRoutingReliability("candidate-model");
  expect(routingReliability).toMatchObject({
    totalRequests: 1,
    successCount: 1,
    failedCount: 0,
  });
});

test("modelLifecycleHandler returns an honest zero for a model absent from the gateway ledger", async () => {
  seedGatewayCall({ resolvedModel: "unrelated-model", success: 1 });

  const routingReliability = await readRoutingReliability("never-routed-model");
  expect(routingReliability).toEqual({
    totalRequests: 0,
    successCount: 0,
    fallbackCount: 0,
    failedCount: 0,
    avgLatencyMs: null,
  });
});

test("modelLifecycleHandler averages gateway ledger latency for the resolved model", async () => {
  seedGatewayCall({ resolvedModel: "candidate-model", success: 1, latencyMs: 100 });
  seedGatewayCall({ resolvedModel: "candidate-model", success: 0, latencyMs: 300 });
  seedGatewayCall({ resolvedModel: "other-model", success: 1, latencyMs: 1_000 });

  const routingReliability = await readRoutingReliability("candidate-model");
  expect(routingReliability.avgLatencyMs).toBe(200);
});

test("modelLifecycleHandler blocks promotion when quality policy blocks the model", async () => {
  writeHealth("candidate-model");
  writeQuality("candidate-model", { status: "blocked", recentFailures: [1], consecutiveGarbage: 0 });
  seedEval("candidate-model", 2000, { score: 0.95, latencyMs: 90, error: null });

  const res = modelLifecycleHandler("candidate-model");
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };
  expect(body.data.promotionReadiness.gate).toBe("blocked");
  expect(body.data.promotionReadiness.reasons).toContain("quality status is blocked");
  expect(body.data.promotionReadiness.reasons).toContain("quality policy reports recent failures: 1");
});

test("modelLifecycleHandler returns ready when real evals pass and approval is approved", async () => {
  writeHealth("candidate-model");
  writeQuality("candidate-model");
  seedEval("candidate-model", 2000, { score: 0.95, latencyMs: 90, error: null });
  const request = createApprovalRequest("model-promotion:candidate-model", "run-candidate", "operator", 1, Date.now() + 60_000);
  submitVote(request.id, "owner", "approve");

  const res = modelLifecycleHandler("candidate-model");
  expect(res.status).toBe(200);
  const body = await res.json() as { data: any };
  expect(body.data.approval.status).toBe("approved");
  expect(body.data.promotionReadiness.gate).toBe("ready");
  expect(body.data.promotionReadiness.reasons).toContain(`promotion approval ${request.id} is approved`);
});

test("promotion request mutation without token is rejected by the router", async () => {
  writeHealth("candidate-model");
  writeQuality("candidate-model");
  seedEval("candidate-model", 2000, { score: 0.95, latencyMs: 90, error: null });

  const req = new Request("http://localhost/api/models/candidate-model/promotion-request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "promote candidate" }),
  });
  const res = await handleApi(req, new URL(req.url));
  expect(res.status).toBe(401);
});
