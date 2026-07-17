import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { withTenantContext } from "../tenancy/middleware.ts";
import {
  hasRunnerUsageForSession,
  isNonGatewayCliLane,
  recordRunnerUsage,
  registryAgentIdForLane,
} from "./runnerAccounting.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "runner-accounting-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  rmSync(tempDir, { recursive: true, force: true });
});

function db() {
  return getDashboardDb()!;
}

async function asTenant(tenantId: string, fn: () => void): Promise<void> {
  const handler = withTenantContext(async () => {
    fn();
    return new Response("ok");
  });
  await handler(new Request("http://localhost/test", { headers: { "x-tenant-id": tenantId } }));
}

describe("isNonGatewayCliLane", () => {
  test("returns true for codex, claude, and gemini", () => {
    expect(isNonGatewayCliLane("codex")).toBe(true);
    expect(isNonGatewayCliLane("claude")).toBe(true);
    expect(isNonGatewayCliLane("gemini")).toBe(true);
  });

  test("returns false for opencode (gateway lane)", () => {
    expect(isNonGatewayCliLane("opencode")).toBe(false);
  });

  test("returns false for null/undefined/empty/other", () => {
    expect(isNonGatewayCliLane(null)).toBe(false);
    expect(isNonGatewayCliLane(undefined)).toBe(false);
    expect(isNonGatewayCliLane("")).toBe(false);
    expect(isNonGatewayCliLane("something-else")).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(isNonGatewayCliLane("CODEX")).toBe(true);
    expect(isNonGatewayCliLane("Gemini")).toBe(true);
  });
});

describe("registryAgentIdForLane", () => {
  test("maps CLI lanes to their runner registry ids", () => {
    expect(registryAgentIdForLane("gemini")).toBe("gemini-runner");
    expect(registryAgentIdForLane("codex")).toBe("codex-runner");
    expect(registryAgentIdForLane("claude")).toBe("claude-runner");
    expect(registryAgentIdForLane("opencode")).toBe("opencode-runner");
  });

  test("returns null for unknown lane", () => {
    expect(registryAgentIdForLane("random")).toBeNull();
    expect(registryAgentIdForLane("")).toBeNull();
  });
});

describe("recordRunnerUsage", () => {
  test("stamps a supplied trace id on the gateway_calls row", () => {
    recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "br_trace", traceId: "t-1" });

    const row = db().query("SELECT trace_id FROM gateway_calls").get() as { trace_id: string | null };
    expect(row.trace_id).toBe("t-1");
  });

  test("leaves trace_id null when no trace id is supplied", () => {
    recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "br_no_trace" });

    const row = db().query("SELECT trace_id FROM gateway_calls").get() as { trace_id: string | null };
    expect(row.trace_id).toBeNull();
  });

  test("stamps the active tenant on gateway_calls and the matching cost_events row", async () => {
    await asTenant("tenant-r0b", () => {
      recordRunnerUsage({ agentKind: "codex", sessionOrRunId: "br_tenant" });
    });

    const gatewayRow = db().query("SELECT tenant_id FROM gateway_calls").get() as { tenant_id: string | null };
    const costRow = db().query("SELECT tenant_id FROM cost_events").get() as { tenant_id: string | null };
    expect(gatewayRow.tenant_id).toBe("tenant-r0b");
    expect(gatewayRow.tenant_id).toBe(costRow.tenant_id);
  });

  test("keeps dedup behavior unchanged for a repeated sessionOrRunId", () => {
    recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "br_trace_dup", traceId: "trace-first" });
    recordRunnerUsage({ agentKind: "codex", sessionOrRunId: "br_trace_dup", traceId: "trace-second" });

    const costCount = db().query("SELECT COUNT(*) AS n FROM cost_events").get() as { n: number };
    const gatewayRows = db().query("SELECT trace_id FROM gateway_calls").all() as Array<{ trace_id: string | null }>;
    expect(costCount.n).toBe(1);
    expect(gatewayRows).toEqual([{ trace_id: "trace-first" }]);
  });

  test("builder accounting reuses the stamped pass trace id", () => {
    const runnerSource = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
    expect(runnerSource).toContain("updateBuilderPass(passId, { traceId });");
    expect(runnerSource).toContain("traceId: currentPass?.traceId ?? run.traceId ?? undefined,");

    const pass = { traceId: "trace-pass-existing" };
    const run = { traceId: "trace-run-existing" };
    recordRunnerUsage({
      agentKind: "claude",
      sessionOrRunId: "br_builder_trace",
      traceId: pass.traceId ?? run.traceId ?? undefined,
    });

    const row = db().query("SELECT trace_id FROM gateway_calls").get() as { trace_id: string | null };
    expect(row.trace_id).toBe(pass.traceId);
  });

  test("inserts one cost_events row and one gateway_calls row for gemini", () => {
    recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "br_abc", detail: "pass 1 done" });

    const costRows = db().query("SELECT * FROM cost_events").all() as Array<{
      source: string;
      logical_model: string;
      provider: string;
      tier: string;
      cost_cents: number;
      cost_basis: string;
      metadata_json: string;
    }>;
    expect(costRows.length).toBe(1);
    expect(costRows[0].source).toBe("runner");
    expect(costRows[0].logical_model).toBe("gemini");
    expect(costRows[0].provider).toBe("gemini");
    expect(costRows[0].tier).toBe("cloud-free");
    expect(costRows[0].cost_cents).toBe(0);
    expect(costRows[0].cost_basis).toBe("cli-unmetered");
    const metadata = JSON.parse(costRows[0].metadata_json) as { sessionOrRunId: string; detail: string };
    expect(metadata.sessionOrRunId).toBe("br_abc");
    expect(metadata.detail).toBe("pass 1 done");

    const gwRows = db().query("SELECT * FROM gateway_calls").all() as Array<{
      backend: string;
      tier: string;
      cost_estimate_usd: number | null;
      success: number;
      caller: string;
      logical_model: string;
      resolved_model: string;
    }>;
    expect(gwRows.length).toBe(1);
    expect(gwRows[0].backend).toBe("cli-direct");
    expect(gwRows[0].tier).toBe("cloud-free");
    expect(gwRows[0].cost_estimate_usd).toBeNull();
    expect(gwRows[0].success).toBe(1);
    expect(gwRows[0].caller).toBe("gemini-runner");
    expect(gwRows[0].logical_model).toBe("gemini");
    expect(gwRows[0].resolved_model).toBe("gemini");
  });

  test("inserts both rows for codex and claude with the right registry caller", () => {
    recordRunnerUsage({ agentKind: "codex", sessionOrRunId: "br_codex_1" });
    recordRunnerUsage({ agentKind: "claude", sessionOrRunId: "br_claude_1" });

    const costRows = db().query("SELECT logical_model FROM cost_events ORDER BY ts ASC").all() as Array<{ logical_model: string }>;
    expect(costRows.map((r) => r.logical_model)).toEqual(["codex", "claude"]);

    const gwRows = db().query("SELECT caller FROM gateway_calls ORDER BY ts ASC").all() as Array<{ caller: string }>;
    expect(gwRows.map((r) => r.caller)).toEqual(["codex-runner", "claude-runner"]);
  });

  test("second call with the same sessionOrRunId inserts nothing", () => {
    recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "br_dup" });
    recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "br_dup" });
    recordRunnerUsage({ agentKind: "codex", sessionOrRunId: "br_dup" });

    const costCount = db().query("SELECT COUNT(*) AS n FROM cost_events").get() as { n: number };
    expect(costCount.n).toBe(1);
    const gwCount = db().query("SELECT COUNT(*) AS n FROM gateway_calls").get() as { n: number };
    expect(gwCount.n).toBe(1);

    expect(hasRunnerUsageForSession("br_dup")).toBe(true);
  });

  test("different sessionOrRunIds are not deduped", () => {
    recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "br_one" });
    recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "br_two" });

    const costCount = db().query("SELECT COUNT(*) AS n FROM cost_events").get() as { n: number };
    expect(costCount.n).toBe(2);
  });

  test("does not insert when agentKind is opencode (gateway lane)", () => {
    recordRunnerUsage({ agentKind: "opencode", sessionOrRunId: "br_oc" });

    const costCount = db().query("SELECT COUNT(*) AS n FROM cost_events").get() as { n: number };
    expect(costCount.n).toBe(0);
    const gwCount = db().query("SELECT COUNT(*) AS n FROM gateway_calls").get() as { n: number };
    expect(gwCount.n).toBe(0);
    expect(hasRunnerUsageForSession("br_oc")).toBe(false);
  });

  test("does not insert for an unknown agent kind", () => {
    recordRunnerUsage({ agentKind: "wat", sessionOrRunId: "br_wat" });
    const costCount = db().query("SELECT COUNT(*) AS n FROM cost_events").get() as { n: number };
    expect(costCount.n).toBe(0);
  });

  test("does not insert when sessionOrRunId is empty", () => {
    recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "" });
    const costCount = db().query("SELECT COUNT(*) AS n FROM cost_events").get() as { n: number };
    expect(costCount.n).toBe(0);
  });
});

describe("recordRunnerUsage with DB disabled", () => {
  test("is a no-op when DASHBOARD_DB is not set", () => {
    closeDashboardDb();
    process.env.DASHBOARD_DB = "0";
    expect(() => recordRunnerUsage({ agentKind: "gemini", sessionOrRunId: "br_off" })).not.toThrow();
    expect(hasRunnerUsageForSession("br_off")).toBe(false);
  });
});
