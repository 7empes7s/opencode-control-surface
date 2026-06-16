import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { readOperatorState } from "../db/writer.ts";
import { _resetGatewayConfigCacheForTests } from "../gateway/config.ts";

const gatewayCalls: Array<{ model: string; caller?: string; prompt?: string }> = [];
let stubbedError: Error | null = null;
let stubbedAnswerByModel: Record<string, string> = {};
let stubbedJudgeByModel: Record<string, string> = {};

mock.module("../gateway/router.ts", () => {
  return {
    gatewayComplete: async (
      logicalModel: string,
      req: { model?: string; messages?: Array<{ content?: string }> },
      opts: { caller?: string; traceId?: string | null; timeoutMs?: number } = {},
    ) => {
      gatewayCalls.push({
        model: logicalModel,
        caller: opts.caller,
        prompt: req?.messages?.[0]?.content,
      });
      if (stubbedError) throw stubbedError;
      const isJudge = opts.caller === "model-eval-judge";
      let answer: string;
      if (isJudge) {
        // The judge call receives the eval answer inside its prompt; route
        // the score based on which free-model is being scored.
        const judgePrompt = req?.messages?.[0]?.content ?? "";
        const matchedKey = Object.keys(stubbedJudgeByModel).find((k) => judgePrompt.includes(k));
        answer = matchedKey
          ? stubbedJudgeByModel[matchedKey]
          : '{"score": 7, "reason": "fallback judge"}';
      } else {
        answer = stubbedAnswerByModel[logicalModel] ?? "stub answer";
      }
      return {
        id: `stub-${Date.now()}`,
        object: "chat.completion" as const,
        created: Math.floor(Date.now() / 1000),
        model: logicalModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: answer },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  };
});

// After mock.module is registered, dynamically import the module under test.
const modelEval = await import("./modelEval.ts");
const { runModelEvalOnce, __TESTING__ } = modelEval;
void __TESTING__; // expose for tests if needed

function withTestTenantContext<R>(context: { tenantId: string }, fn: () => R): R {
  return tenantStore.run(testTenantContext(context), fn);
}

let tempDir: string;
let configPath: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevGatewayConfig: string | undefined;

const SAMPLE_YAML = `
version: 1
litellm_url: http://127.0.0.1:4000
models:
  free-a:
    model: free-a-resolved
    tier: cloud-free
    fallback_chain: []
  free-b:
    model: free-b-resolved
    tier: cloud-free
    fallback_chain: []
  paid-x:
    model: paid-x-resolved
    tier: cloud-paid
    fallback_chain: []
circuit_breaker:
  failure_threshold: 3
  reset_timeout_ms: 60000
  probe_timeout_ms: 8000
cost_estimates:
  local: { prompt: 0, completion: 0 }
  cloud-free: { prompt: 0, completion: 0 }
  cloud-paid: { prompt: 2, completion: 8 }
`;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "model-eval-test-"));
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
  configPath = join(tempDir, "gateway.yaml");
  writeFileSync(configPath, SAMPLE_YAML, "utf8");

  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevGatewayConfig = process.env.GATEWAY_CONFIG;

  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.GATEWAY_CONFIG = configPath;

  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });

  // The gateway config module caches by (path, timestamp). The module is loaded
  // before our env var is set, so we reset the cache to force a re-read of the
  // synthetic config we just wrote.
  _resetGatewayConfigCacheForTests();

  // Defensive: ensure the daily marker is gone in this fresh DB so each test
  // sees a clean slate.
  try {
    const db = getDashboardDb();
    if (db) db.run("DELETE FROM operator_state WHERE key = 'model-eval.daily-marker'");
  } catch { /* ignore — table may not exist yet on first call */ }

  // Reset call log + stubs
  gatewayCalls.length = 0;
  stubbedError = null;
  stubbedAnswerByModel = {
    "free-a": "tag=free-a Audit trails create accountability for autonomous agents.",
    "free-b": "tag=free-b Without audit trails, autonomous agent decisions are unverifiable.",
  };
  stubbedJudgeByModel = {
    "tag=free-a": '{"score": 8, "reason": "concise and correct"}',
    "tag=free-b": '{"score": 6, "reason": "ok but a bit vague"}',
  };
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  if (prevGatewayConfig === undefined) delete process.env.GATEWAY_CONFIG;
  else process.env.GATEWAY_CONFIG = prevGatewayConfig;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runModelEvalOnce", () => {
  test("picks up to 3 cloud-free models and runs + judges each one", async () => {
    const outcome = await withTestTenantContext({ tenantId: "mimule" }, async () => {
      return await runModelEvalOnce(1_700_000_000_000);
    });

    expect(outcome.skipped).toBe(false);
    expect(outcome.results.length).toBeGreaterThanOrEqual(2);
    expect(outcome.results.length).toBeLessThanOrEqual(3);

    // Each result is a per-model row
    const models = outcome.results.map((r) => r.model);
    expect(models).toContain("free-a");
    expect(models).toContain("free-b");
    expect(models).not.toContain("paid-x"); // tier filter

    // One eval call per model + one judge call per model (judge is editorial-cloud-heavy).
    const evalCalls = gatewayCalls.filter((c) => c.caller === "model-eval");
    const judgeCalls = gatewayCalls.filter((c) => c.caller === "model-eval-judge");
    expect(evalCalls.length).toBe(outcome.results.length);
    expect(judgeCalls.length).toBe(outcome.results.length);

    // The eval prompt is the fixed one.
    for (const c of evalCalls) {
      expect(c.prompt).toContain("audit trails matter for autonomous AI agents");
    }

    // Scores parsed from the judge JSON
    const freeA = outcome.results.find((r) => r.model === "free-a")!;
    expect(freeA.score).toBe(8);
    const freeB = outcome.results.find((r) => r.model === "free-b")!;
    expect(freeB.score).toBe(6);

    // metric_samples has one row per model
    const db = getDashboardDb()!;
    const rows = db.query(
      "SELECT key, value_json FROM metric_samples WHERE source = 'model-eval' ORDER BY key",
    ).all() as Array<{ key: string; value_json: string }>;
    expect(rows.length).toBe(outcome.results.length);
    for (const row of rows) {
      const parsed = JSON.parse(row.value_json) as { score: number; latencyMs: number; ts: number };
      expect(typeof parsed.score).toBe("number");
      expect(typeof parsed.latencyMs).toBe("number");
      expect(typeof parsed.ts).toBe("number");
    }
  });

  test("second run on the same UTC day is a no-op (dedupe marker)", async () => {
    const first = await withTestTenantContext({ tenantId: "mimule" }, async () => {
      return await runModelEvalOnce(1_700_000_000_000);
    });
    expect(first.skipped).toBe(false);
    const firstCallCount = gatewayCalls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Second call, same UTC date. The marker must short-circuit.
    const second = await withTestTenantContext({ tenantId: "mimule" }, async () => {
      return await runModelEvalOnce(1_700_000_000_000);
    });
    expect(second.skipped).toBe(true);
    expect(second.skipReason).toContain("already ran today");
    expect(second.results.length).toBe(0);

    // No additional gateway calls were made.
    expect(gatewayCalls.length).toBe(firstCallCount);

    // The marker exists in operator_state.
    const marker = await withTestTenantContext({ tenantId: "mimule" }, () =>
      readOperatorState("model-eval.daily-marker"),
    ) as { date?: string; models?: number } | null;
    expect(marker).toBeTruthy();
    expect(typeof marker?.date).toBe("string");
    expect(marker?.models).toBe(first.results.length);
  });

  test("partial failure path: judge parse failure => score 0, never throws", async () => {
    stubbedAnswerByModel = { "free-a": "tag=free-a ok", "free-b": "tag=free-b ok" };
    stubbedJudgeByModel = {
      "tag=free-a": "this is not json and has no number",
      "tag=free-b": '{"score": 9}',
    };

    const outcome = await withTestTenantContext({ tenantId: "mimule" }, async () => {
      return await runModelEvalOnce(1_700_000_500_000);
    });
    expect(outcome.skipped).toBe(false);

    const a = outcome.results.find((r) => r.model === "free-a");
    const b = outcome.results.find((r) => r.model === "free-b");
    expect(a?.score).toBe(0);
    expect(b?.score).toBe(9);
    // No throw: outcome is returned with both rows present.
    expect(outcome.results.length).toBeGreaterThanOrEqual(2);
  });

  test("complete gateway failure is recorded as error, does not throw", async () => {
    stubbedError = new Error("upstream is down");
    const outcome = await withTestTenantContext({ tenantId: "mimule" }, async () => {
      return await runModelEvalOnce(1_700_001_000_000);
    });
    expect(outcome.skipped).toBe(false);
    expect(outcome.results.length).toBeGreaterThan(0);
    for (const r of outcome.results) {
      expect(r.error).toContain("upstream is down");
      expect(r.score).toBe(0);
    }
    // errorCount counts the rows that have either an error or score=0
    expect(outcome.errorCount).toBe(outcome.results.length);
  });

  test("skips with reason when DB is disabled", async () => {
    closeDashboardDb();
    process.env.DASHBOARD_DB = "0";
    const outcome = await runModelEvalOnce(1_700_002_000_000);
    expect(outcome.skipped).toBe(true);
    expect(outcome.skipReason).toContain("DASHBOARD_DB");
    expect(outcome.results.length).toBe(0);
    // No gateway calls made.
    expect(gatewayCalls.length).toBe(0);
  });
});
