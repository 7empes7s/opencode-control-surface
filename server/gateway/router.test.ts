import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import type { CompletionRequest, CompletionResponse } from "./adapters/base.ts";
import { _resetGatewayConfigCacheForTests } from "./config.ts";
import { classifyError, gatewayComplete, getCircuitStates, resetGatewayRouteOverrideStateForTests } from "./router.ts";

type GatewayRow = {
  trace_id: string | null;
  resolved_model: string;
  success: number;
  error_class: string | null;
};

type MockOutcome = "success" | "failure" | "unreachable" | "timeout";

const request: CompletionRequest = {
  model: "ignored-by-gateway",
  messages: [{ role: "user", content: "trace test" }],
};

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousGatewayConfig: string | undefined;
let previousFetch: typeof fetch;
let adapterCalls: Map<string, number>;

function installAdapterMock(outcomes: Record<string, MockOutcome | MockOutcome[]>): void {
  adapterCalls = new Map();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      if (!url.includes("/v1/chat/completions")) {
        throw new Error(`Unexpected gateway test request: ${url}`);
      }

      const body = JSON.parse(String(init?.body)) as CompletionRequest;
      const configuredOutcome = outcomes[body.model];
      if (!configuredOutcome) throw new Error(`No gateway test outcome for model: ${body.model}`);
      const callIndex = adapterCalls.get(body.model) ?? 0;
      adapterCalls.set(body.model, callIndex + 1);
      const outcome = Array.isArray(configuredOutcome)
        ? configuredOutcome[Math.min(callIndex, configuredOutcome.length - 1)]
        : configuredOutcome;
      if (outcome === "failure") {
        return new Response("synthetic failure", { status: 503 });
      }
      if (outcome === "unreachable") {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      }
      if (outcome === "timeout") {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }

      const response: CompletionResponse = {
        id: `mock-${body.model}`,
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
}

function rowsFor(logicalModel: string): GatewayRow[] {
  return getDashboardDb()!.query(`
    SELECT trace_id, resolved_model, success, error_class
    FROM gateway_calls
    WHERE logical_model = ?
    ORDER BY id ASC
  `).all(logicalModel) as GatewayRow[];
}

beforeEach(() => {
  closeDashboardDb();
  resetGatewayRouteOverrideStateForTests();
  tempDir = mkdtempSync(join(tmpdir(), "gateway-router-test-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  previousGatewayConfig = process.env.GATEWAY_CONFIG;
  previousFetch = globalThis.fetch;

  const configPath = join(tempDir, "gateway.yaml");
  writeFileSync(configPath, `
version: 1
litellm_url: http://gateway-router.test
models:
  trace-mint:
    model: trace-mint
    tier: local
    fallback_chain: []
  trace-hops:
    model: trace-hop-first
    tier: local
    fallback_chain: [trace-hop-second]
  trace-hop-second:
    model: trace-hop-second
    tier: cloud-free
    fallback_chain: []
  trace-explicit:
    model: trace-explicit
    tier: local
    fallback_chain: []
  trace-distinct:
    model: trace-distinct
    tier: local
    fallback_chain: []
  trace-failure:
    model: trace-failure-first
    tier: local
    fallback_chain: [trace-failure-second]
  trace-failure-second:
    model: trace-failure-second
    tier: cloud-free
    fallback_chain: []
  infra-once:
    model: infra-once
    tier: local
    fallback_chain: []
  infra-breaker:
    model: infra-breaker
    tier: local
    fallback_chain: []
  infra-cascade:
    model: infra-cascade-first
    tier: local
    fallback_chain: [infra-cascade-second]
  infra-cascade-second:
    model: infra-cascade-second
    tier: cloud-free
    fallback_chain: []
  infra-recover:
    model: infra-recover
    tier: local
    fallback_chain: []
  model-error:
    model: model-error-first
    tier: local
    fallback_chain: [model-error-second]
  model-error-second:
    model: model-error-second
    tier: cloud-free
    fallback_chain: []
  timeout-error:
    model: timeout-error-first
    tier: local
    fallback_chain: [timeout-error-second]
  timeout-error-second:
    model: timeout-error-second
    tier: cloud-free
    fallback_chain: []
  infra-trace:
    model: infra-trace
    tier: local
    fallback_chain: []
circuit_breaker:
  failure_threshold: 3
  reset_timeout_ms: 60000
  probe_timeout_ms: 8000
cost_estimates:
  local:
    prompt: 0
    completion: 0
  cloud-free:
    prompt: 0
    completion: 0
  cloud-paid:
    prompt: 2
    completion: 8
`);

  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.GATEWAY_CONFIG = configPath;
  _resetGatewayConfigCacheForTests();
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  resetGatewayRouteOverrideStateForTests();
  closeDashboardDb();
  if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDashboardDb;
  if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
  if (previousGatewayConfig === undefined) delete process.env.GATEWAY_CONFIG;
  else process.env.GATEWAY_CONFIG = previousGatewayConfig;
  _resetGatewayConfigCacheForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("gatewayComplete trace correlation", () => {
  test("mints a non-empty trace id when absent", async () => {
    installAdapterMock({ "trace-mint": "success" });

    await gatewayComplete("trace-mint", request);

    const rows = rowsFor("trace-mint");
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].trace_id).toBe("string");
    expect(rows[0].trace_id!.length).toBeGreaterThan(0);
  });

  test("uses one trace id across failed and successful fallback hops", async () => {
    installAdapterMock({
      "trace-hop-first": "failure",
      "trace-hop-second": "success",
    });

    await gatewayComplete("trace-hops", request);

    const rows = rowsFor("trace-hops");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.success)).toEqual([0, 1]);
    expect(rows[0].trace_id).not.toBeNull();
    expect(rows[1].trace_id).toBe(rows[0].trace_id);
  });

  test("preserves a caller-supplied trace id", async () => {
    installAdapterMock({ "trace-explicit": "success" });

    await gatewayComplete("trace-explicit", request, { traceId: "caller-supplied" });

    const rows = rowsFor("trace-explicit");
    expect(rows).toHaveLength(1);
    expect(rows[0].trace_id).toBe("caller-supplied");
  });

  test("mints distinct trace ids for distinct invocations", async () => {
    installAdapterMock({ "trace-distinct": "success" });

    await gatewayComplete("trace-distinct", request);
    await gatewayComplete("trace-distinct", request);

    const rows = rowsFor("trace-distinct");
    expect(rows).toHaveLength(2);
    expect(rows[0].trace_id).not.toBeNull();
    expect(rows[1].trace_id).not.toBeNull();
    expect(rows[1].trace_id).not.toBe(rows[0].trace_id);
  });

  test("uses one trace id when every fallback hop fails", async () => {
    installAdapterMock({
      "trace-failure-first": "failure",
      "trace-failure-second": "failure",
    });

    await expect(gatewayComplete("trace-failure", request)).rejects.toThrow("LiteLLM 503");

    const rows = rowsFor("trace-failure");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.success === 0)).toBe(true);
    expect(rows[0].trace_id).not.toBeNull();
    expect(rows[1].trace_id).toBe(rows[0].trace_id);
  });
});

describe("gatewayComplete infrastructure failures", () => {
  test("retries an unreachable gateway once and records one infrastructure failure", async () => {
    installAdapterMock({ "infra-once": "unreachable" });

    await expect(gatewayComplete("infra-once", request)).rejects.toThrow("Unable to connect");

    expect(adapterCalls.get("infra-once")).toBe(2);
    expect(rowsFor("infra-once")).toEqual([{
      trace_id: expect.any(String),
      resolved_model: "infra-once",
      success: 0,
      error_class: "gateway_unreachable",
    }]);
  });

  test("does not trip the model circuit breaker for an infrastructure failure", async () => {
    installAdapterMock({ "infra-breaker": "unreachable" });

    await expect(gatewayComplete("infra-breaker", request)).rejects.toThrow("Unable to connect");

    expect(getCircuitStates()["infra-breaker"]).toEqual({
      state: "closed",
      failures: 0,
      openedAt: null,
    });
  });

  test("stops the fallback cascade when the gateway is unreachable", async () => {
    installAdapterMock({
      "infra-cascade-first": "unreachable",
      "infra-cascade-second": "success",
    });

    await expect(gatewayComplete("infra-cascade", request)).rejects.toThrow("Unable to connect");

    expect(adapterCalls.get("infra-cascade-first")).toBe(2);
    expect(adapterCalls.get("infra-cascade-second") ?? 0).toBe(0);
    expect(rowsFor("infra-cascade").map((row) => row.resolved_model)).toEqual(["infra-cascade-first"]);
  });

  test("returns success when the infrastructure retry recovers", async () => {
    installAdapterMock({ "infra-recover": ["unreachable", "success"] });

    const result = await gatewayComplete("infra-recover", request);

    expect(result.model).toBe("infra-recover");
    expect(adapterCalls.get("infra-recover")).toBe(2);
    expect(rowsFor("infra-recover").map((row) => ({ success: row.success, errorClass: row.error_class }))).toEqual([
      { success: 1, errorClass: null },
    ]);
  });

  test("keeps real model errors on the existing failure and fallback path", async () => {
    installAdapterMock({
      "model-error-first": "failure",
      "model-error-second": "success",
    });

    const result = await gatewayComplete("model-error", request);

    expect(result.model).toBe("model-error-second");
    expect(adapterCalls.get("model-error-first")).toBe(1);
    expect(adapterCalls.get("model-error-second")).toBe(1);
    expect(rowsFor("model-error").map((row) => ({ success: row.success, errorClass: row.error_class }))).toEqual([
      { success: 0, errorClass: "unavailable" },
      { success: 1, errorClass: null },
    ]);
    expect(getCircuitStates()["model-error"]?.failures).toBe(1);
  });

  test("keeps timeouts on the existing failure and fallback path", async () => {
    installAdapterMock({
      "timeout-error-first": "timeout",
      "timeout-error-second": "success",
    });

    const result = await gatewayComplete("timeout-error", request);

    expect(result.model).toBe("timeout-error-second");
    expect(adapterCalls.get("timeout-error-first")).toBe(1);
    expect(adapterCalls.get("timeout-error-second")).toBe(1);
    expect(rowsFor("timeout-error").map((row) => ({ success: row.success, errorClass: row.error_class }))).toEqual([
      { success: 0, errorClass: "timeout" },
      { success: 1, errorClass: null },
    ]);
    expect(getCircuitStates()["timeout-error"]?.failures).toBe(1);
  });

  test("preserves the request trace id on an infrastructure failure", async () => {
    installAdapterMock({ "infra-trace": "unreachable" });

    await expect(gatewayComplete("infra-trace", request, { traceId: "infra-trace-id" })).rejects.toThrow(
      "Unable to connect",
    );

    const rows = rowsFor("infra-trace");
    expect(rows).toHaveLength(1);
    expect(rows[0].trace_id).toBe("infra-trace-id");
    expect(rows[0].error_class).toBe("gateway_unreachable");
  });
});

describe("classifyError", () => {
  const cases: Array<[message: string, expected: string]> = [
    ["LiteLLM 500: internal server error", "server_error"],
    ["LiteLLM 502: bad gateway", "server_error"],
    ["LiteLLM 504: upstream gateway error", "server_error"],
    ["LiteLLM 504: upstream timeout", "timeout"],
    ["LiteLLM 400: model gpt-5 not found", "unknown"],
    ["LiteLLM 400: expected 5 candidates", "unknown"],
    ["LiteLLM 400: expected 500 tokens", "unknown"],
    ["request failed after 1500ms", "unknown"],
    ["LiteLLM 429: rate limited", "rate_limit"],
    ["LiteLLM 401: unauthorized", "auth"],
    ["LiteLLM 503: service unavailable", "unavailable"],
    ["The operation was aborted", "timeout"],
  ];

  for (const [message, expected] of cases) {
    test(`${message} -> ${expected}`, () => {
      expect(classifyError(new Error(message))).toBe(expected);
    });
  }
});
