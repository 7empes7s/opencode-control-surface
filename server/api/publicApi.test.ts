import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  _getPublicApiRateLimit,
  _setPublicApiRateLimitForTests,
  publicApiAgentsHandler,
  publicApiAuditHandler,
  publicApiCostHandler,
  publicApiInsightsHandler,
  publicApiTrustScoreHandler,
  webhooksCreateHandler,
  webhooksDisableHandler,
  webhooksListHandler,
} from "./publicApi.ts";
import { createGatewayKey } from "../gateway/keys.ts";
import { seedDefaultAgents } from "../agents/registry.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "public-api-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "public-api-test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  resetRateLimitBucket();
});

afterEach(() => {
  closeDashboardDb();
  _setPublicApiRateLimitForTests(null);
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  rmSync(tempDir, { recursive: true, force: true });
});

function withTenant<R>(tenantId: string, fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

function resetRateLimitBucket(): void {
  const g = globalThis as unknown as { __publicApiRateLimit?: Record<string, unknown> };
  if (g.__publicApiRateLimit) g.__publicApiRateLimit = {};
}

function opReq(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { "x-operator-token": "public-api-test-token" },
  });
}

function anonReq(path: string): Request {
  return new Request(`http://localhost${path}`);
}

describe("public API — authentication", () => {
  test("401 plain-English when no Bearer and no operator token", async () => {
    const res = await publicApiInsightsHandler(anonReq("/api/v1/insights"));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.error).toContain("Bearer");
  });

  test("401 when bearer is malformed (not gwk_*)", async () => {
    const req = new Request("http://localhost/api/v1/insights", {
      headers: { Authorization: "Bearer not-a-key" },
    });
    const res = await publicApiInsightsHandler(req);
    expect(res.status).toBe(401);
  });

  test("200 with valid operator token on /api/v1/insights", async () => {
    const res = await publicApiInsightsHandler(opReq("/api/v1/insights"));
    expect(res.status).toBe(200);
    const body = await res.json() as { openCount: number; insights: unknown[] };
    expect(typeof body.openCount).toBe("number");
    expect(Array.isArray(body.insights)).toBe(true);
  });

  test("200 with valid operator token on /api/v1/agents", async () => {
    const res = await publicApiAgentsHandler(opReq("/api/v1/agents"));
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; agents: unknown[] };
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.agents)).toBe(true);
  });

  test("200 with valid operator token on /api/v1/audit (redacted columns)", async () => {
    const res = await publicApiAuditHandler(opReq("/api/v1/audit"));
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; rows: Array<Record<string, unknown>> };
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.rows)).toBe(true);
    for (const row of body.rows) {
      // MUST contain only the redacted column set
      const keys = Object.keys(row).sort();
      expect(keys).toEqual(["action", "actor", "resultStatus", "targetId", "targetType", "ts"]);
    }
  });

  test("200 with valid operator token on /api/v1/trust-score", async () => {
    const res = await publicApiTrustScoreHandler(opReq("/api/v1/trust-score"));
    expect(res.status).toBe(200);
    const body = await res.json() as { score: number; maxScore: number; computedAt: number };
    expect(typeof body.score).toBe("number");
    expect(body.maxScore).toBe(100);
  });

  test("200 with valid operator token on /api/v1/cost", async () => {
    const res = await publicApiCostHandler(opReq("/api/v1/cost"));
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean; calls: number; totalCostUsd: number };
    expect(body.enabled).toBe(true);
    expect(typeof body.calls).toBe("number");
  });
});

describe("public API — gateway key auth", () => {
  test("200 with valid gwk_* Bearer token on /api/v1/agents", async () => {
    withTenant("mimule", () => seedDefaultAgents());
    const created = withTenant("mimule", () =>
      createGatewayKey("product-sentinel", "public-api-test", { dailyCapUsd: 1 }),
    );
    const res = await publicApiAgentsHandler(
      new Request("http://localhost/api/v1/agents", {
        headers: { Authorization: `Bearer ${created.key}` },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("public API — rate limiting (429)", () => {
  test("returns 429 after exceeding the per-credential limit", async () => {
    _setPublicApiRateLimitForTests(3);
    expect(_getPublicApiRateLimit()).toBe(3);

    const r1 = await publicApiAgentsHandler(opReq("/api/v1/agents"));
    const r2 = await publicApiAgentsHandler(opReq("/api/v1/agents"));
    const r3 = await publicApiAgentsHandler(opReq("/api/v1/agents"));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    const r4 = await publicApiAgentsHandler(opReq("/api/v1/agents"));
    expect(r4.status).toBe(429);
    expect(r4.headers.get("Retry-After")).not.toBeNull();
    const body = await r4.json() as { error: string };
    expect(body.error.toLowerCase()).toContain("rate limit");

    // Restore default
    _setPublicApiRateLimitForTests(null);
    expect(_getPublicApiRateLimit()).toBe(120);
  });
});

describe("webhooks management — auth & lifecycle", () => {
  test("GET /api/webhooks — 401 without operator token", async () => {
    const res = await webhooksListHandler(anonReq("/api/webhooks"));
    expect(res.status).toBe(401);
  });

  test("GET /api/webhooks — empty list with operator token", async () => {
    const res = await webhooksListHandler(opReq("/api/webhooks"));
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; webhooks: unknown[] };
    expect(body.count).toBe(0);
  });

  test("POST /api/webhooks — generates secret, returns it ONCE, masks in list, then disable works", async () => {
    const create = await webhooksCreateHandler(
      new Request("http://localhost/api/webhooks", {
        method: "POST",
        headers: { "x-operator-token": "public-api-test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/hook", events: ["insight.critical", "action.applied"] }),
      }),
    );
    expect(create.status).toBe(201);
    const created = await create.json() as {
      webhook: { id: string; url: string; events: string[]; status: string };
      secret: string;
      secretMessage: string;
    };
    expect(created.webhook.id).toStartWith("wh_");
    expect(created.webhook.status).toBe("active");
    expect(created.secret).toStartWith("whsec_");
    expect(created.secretMessage.length).toBeGreaterThan(0);

    // List must NOT include the plaintext secret
    const list = await webhooksListHandler(opReq("/api/webhooks"));
    const lb = await list.json() as { count: number; webhooks: Array<{ id: string; secretMasked: string }> };
    expect(lb.count).toBe(1);
    expect(lb.webhooks[0].id).toBe(created.webhook.id);
    expect(lb.webhooks[0].secretMasked).not.toBe(created.secret);
    expect(lb.webhooks[0].secretMasked).toContain("…");

    // Disable
    const dis = await webhooksDisableHandler(
      new Request(`http://localhost/api/webhooks/${created.webhook.id}/disable`, {
        method: "POST",
        headers: { "x-operator-token": "public-api-test-token" },
      }),
      created.webhook.id,
    );
    expect(dis.status).toBe(200);
    const disBody = await dis.json() as { status: string };
    expect(disBody.status).toBe("disabled");

    // List now shows disabled
    const list2 = await webhooksListHandler(opReq("/api/webhooks"));
    const lb2 = await list2.json() as { webhooks: Array<{ status: string }> };
    expect(lb2.webhooks[0].status).toBe("disabled");
  });

  test("POST /api/webhooks — 400 on missing url or events", async () => {
    const noUrl = await webhooksCreateHandler(
      new Request("http://localhost/api/webhooks", {
        method: "POST",
        headers: { "x-operator-token": "public-api-test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ events: ["x"] }),
      }),
    );
    expect(noUrl.status).toBe(400);

    const noEvents = await webhooksCreateHandler(
      new Request("http://localhost/api/webhooks", {
        method: "POST",
        headers: { "x-operator-token": "public-api-test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/", events: [] }),
      }),
    );
    expect(noEvents.status).toBe(400);
  });
});
