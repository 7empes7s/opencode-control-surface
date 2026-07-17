import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import type { CompletionRequest, CompletionResponse } from "./adapters/base.ts";
import { _resetGatewayConfigCacheForTests } from "./config.ts";
import { gatewayComplete, resetGatewayRouteOverrideStateForTests } from "./router.ts";

type GatewayRow = {
  trace_id: string | null;
  success: number;
};

type MockOutcome = "success" | "failure";

const request: CompletionRequest = {
  model: "ignored-by-gateway",
  messages: [{ role: "user", content: "trace test" }],
};

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousGatewayConfig: string | undefined;
let previousFetch: typeof fetch;

function installAdapterMock(outcomes: Record<string, MockOutcome>): void {
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
      const outcome = outcomes[body.model];
      if (!outcome) throw new Error(`No gateway test outcome for model: ${body.model}`);
      if (outcome === "failure") {
        return new Response("synthetic failure", { status: 503 });
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
    SELECT trace_id, success
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
