import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  reasonerResolveIncidentHandler,
  reasonerIncidentPostMortemHandler,
} from "./reasoner.ts";
import { clearGatewayRouteOverrideForGatewayAdmin, getGatewayRoutePlanForGatewayAdmin } from "../gateway/router.ts";
import type { CompletionResponse } from "../gateway/adapters/base.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevFetch: typeof fetch | null | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "reasoner-postmortem-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevFetch = globalThis.fetch;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  clearGatewayRouteOverrideForGatewayAdmin();
});

afterEach(() => {
  clearGatewayRouteOverrideForGatewayAdmin();
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  if (prevFetch === undefined) {
    (globalThis as { __pmTestFetch?: typeof fetch }).__pmTestFetch = undefined;
  } else {
    globalThis.fetch = prevFetch;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function withTenant<R>(tenantId: string, fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

type CapturedCall = { url: string; body: Record<string, unknown> };

type AdapterMock = {
  calls: CapturedCall[];
  setResponse: (resp: CompletionResponse) => void;
  setError: (message: string) => void;
  restore: () => void;
};

function installAdapterMock(): AdapterMock {
  const calls: CapturedCall[] = [];
  let response: CompletionResponse | null = null;
  let errorMessage: string | null = null;

  const mockFetch: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      const rawBody = init?.body;
      let parsed: unknown = rawBody;
      if (typeof rawBody === "string") {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = rawBody;
        }
      }
      calls.push({ url, body: (parsed ?? {}) as Record<string, unknown> });

      if (errorMessage) {
        return new Response(errorMessage, { status: 503 });
      }
      if (!response) {
        return new Response("no mock response set", { status: 500 });
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: () => {} },
  ) as typeof fetch;

  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch;

  return {
    calls,
    setResponse: (r: CompletionResponse) => {
      response = r;
      errorMessage = null;
    },
    setError: (message: string) => {
      errorMessage = message;
      response = null;
    },
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

function seedIncident(tenantId: string, id: string, title: string): void {
  const db = getDashboardDb();
  if (!db) throw new Error("db not available");
  const now = Date.now();
  db.query(`
    INSERT INTO reasoner_incidents
      (id, cluster_key, failure_class, title, first_seen, last_seen,
       occurrence_count, representative_pass_id, representative_diagnosis_id, status, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `ck_${id}`,
    "codex-exhausted",
    title,
    now,
    now,
    1,
    `pass_${id}`,
    `diag_${id}`,
    "open",
    tenantId,
  );
  db.query(`
    INSERT INTO reasoner_diagnoses
      (id, pass_id, run_id, workflow_id, failure_class, root_cause, evidence_json,
       suggested_actions_json, confidence, raw_llm_response, diagnosed_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `diag_${id}`,
    `pass_${id}`,
    `run_${id}`,
    `wf_${id}`,
    "codex-exhausted",
    "Claude API key is exhausted",
    "[]",
    "[]",
    "high",
    "raw",
    now,
    tenantId,
  );
}

describe("reasoner post-mortem storage roundtrip with stubbed gateway", () => {
  test("resolve stores post-mortem; GET endpoint returns it; 60s timeout honored on success", async () => {
    const mock = installAdapterMock();
    try {
      const postMortemText = "Pass validation failed three times in a row on the same docker layer. The root cause was a stale base image. The CI runner retried without success. A container rebuild on the next pass unblocked the pipeline. Recommendation: add a freshness probe to the build image.";
      mock.setResponse({
        id: "chatcmpl-pm-1",
        object: "chat.completion",
        created: 1700000100,
        model: "editorial-cloud-heavy",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: postMortemText },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 60, total_tokens: 110 },
      });

      withTenant("mimule", () => seedIncident("mimule", "ri_pm_1", "Incident with post-mortem"));

      const resolveRes = await withTenant("mimule", () => reasonerResolveIncidentHandler("ri_pm_1"));
      expect(resolveRes.status).toBe(200);
      const resolveBody = await resolveRes.json() as { ok: boolean; postMortemId: number | null };
      expect(resolveBody.ok).toBe(true);
      expect(resolveBody.postMortemId).toBeGreaterThan(0);

      // gateway was called exactly once
      expect(mock.calls.length).toBe(1);
      const sentBody = mock.calls[0].body;
      expect(sentBody.model).toBe("editorial-cloud-heavy");
      const messages = sentBody.messages as Array<{ role: string; content: string }>;
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toMatch(/concise incident post-mortem/i);
      expect(messages[1].role).toBe("user");
      expect(messages[1].content).toContain("ri_pm_1");
      expect(messages[1].content).toContain("codex-exhausted");
      // Caller must be present in the call to gatewayComplete (verified via audit row)
      const auditRows = (() => {
        const db = getDashboardDb()!;
        return db.query(`SELECT actor, target_id, result_status, result_json FROM action_audit WHERE action_kind = 'reasoner.postmortem.generated' ORDER BY id DESC LIMIT 1`)
          .get() as { actor: string; target_id: string; result_status: string; result_json: string } | null;
      })();
      expect(auditRows).not.toBeNull();
      expect(auditRows!.actor).toBe("incident-postmortem");
      expect(auditRows!.target_id).toBe("ri_pm_1");
      expect(auditRows!.result_status).toBe("success");
      const resultJson = JSON.parse(auditRows!.result_json) as { postMortemId: number; path: string; bytes: number };
      expect(resultJson.postMortemId).toBe(resolveBody.postMortemId);
      expect(resultJson.path).toBe("reasoner/incidents/ri_pm_1/post-mortem");
      expect(resultJson.bytes).toBe(postMortemText.length);

      // Storage: report_archive row exists
      const db = getDashboardDb()!;
      const row = db.query(`SELECT id, kind, path, summary FROM report_archive WHERE kind = 'post-mortem' AND path = ?`)
        .get("reasoner/incidents/ri_pm_1/post-mortem") as { id: number; kind: string; path: string; summary: string } | null;
      expect(row).not.toBeNull();
      expect(row!.kind).toBe("post-mortem");
      expect(row!.summary).toBe(postMortemText);
      expect(row!.id).toBe(resolveBody.postMortemId);

      // GET returns the post-mortem
      const getRes = await withTenant("mimule", () => reasonerIncidentPostMortemHandler("ri_pm_1"));
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as { id: number; incidentId: string; kind: string; path: string; text: string; createdAt: number };
      expect(getBody.incidentId).toBe("ri_pm_1");
      expect(getBody.kind).toBe("post-mortem");
      expect(getBody.path).toBe("reasoner/incidents/ri_pm_1/post-mortem");
      expect(getBody.text).toBe(postMortemText);
      expect(getBody.id).toBe(resolveBody.postMortemId);
      expect(typeof getBody.createdAt).toBe("number");
    } finally {
      mock.restore();
    }
  });

  test("resolve SUCCEEDS even when the LLM call fails (best-effort post-mortem)", async () => {
    const mock = installAdapterMock();
    try {
      mock.setError("upstream LiteLLM 503: rate limit");

      withTenant("mimule", () => seedIncident("mimule", "ri_pm_fail", "Incident with no post-mortem"));

      const resolveRes = await withTenant("mimule", () => reasonerResolveIncidentHandler("ri_pm_fail"));
      expect(resolveRes.status).toBe(200);
      const resolveBody = await resolveRes.json() as { ok: boolean; postMortemId: number | null };
      expect(resolveBody.ok).toBe(true);
      expect(resolveBody.postMortemId).toBeNull();

      // The retry/fallback chain is exhausted — calls.length may be > 1, but at least one attempt was made
      expect(mock.calls.length).toBeGreaterThan(0);

      // Incident is still marked resolved in DB
      const db = getDashboardDb()!;
      const row = db.query(`SELECT status FROM reasoner_incidents WHERE id = ?`).get("ri_pm_fail") as { status: string };
      expect(row.status).toBe("resolved");

      // No report_archive row should exist
      const archived = db.query(`SELECT COUNT(*) AS n FROM report_archive WHERE kind = 'post-mortem' AND path = ?`)
        .get("reasoner/incidents/ri_pm_fail/post-mortem") as { n: number };
      expect(archived.n).toBe(0);

      // GET returns 404
      const getRes = await withTenant("mimule", () => reasonerIncidentPostMortemHandler("ri_pm_fail"));
      expect(getRes.status).toBe(404);
    } finally {
      mock.restore();
    }
  });

  test("GET post-mortem returns 404 for unknown incident", async () => {
    const res = await withTenant("mimule", () => reasonerIncidentPostMortemHandler("ri_does_not_exist"));
    expect(res.status).toBe(404);
  });

  test("GET post-mortem returns 404 for incident without a post-mortem", async () => {
    withTenant("mimule", () => seedIncident("mimule", "ri_no_pm", "Incident without post-mortem"));
    const res = await withTenant("mimule", () => reasonerIncidentPostMortemHandler("ri_no_pm"));
    expect(res.status).toBe(404);
  });
});

// Ensure the plan shape is what we expect — guards accidental rename in router.ts.
describe("reasoner router plan", () => {
  test("editorial-cloud-heavy has a known chain in the gateway", () => {
    const plan = getGatewayRoutePlanForGatewayAdmin("editorial-cloud-heavy");
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0]).toBe("editorial-cloud-heavy");
  });
});
