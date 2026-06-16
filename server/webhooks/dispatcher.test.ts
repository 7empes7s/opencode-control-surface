import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  computeWebhookSignature,
  createWebhook,
  dispatchEvent,
  dispatchToWebhook,
  listWebhooksForTenant,
  __test_only,
} from "./dispatcher.ts";

const HMAC_VECTOR_SECRET = "test-secret";
const HMAC_VECTOR_BODY = '{"a":1}';
const HMAC_VECTOR_EXPECTED = "179bf20a8b9040a32368814a68b0dc270823b5968498e0a73796c4202708ed8d";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevFetch: typeof fetch | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "webhooks-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevFetch = globalThis.fetch;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  globalThis.fetch = prevFetch as typeof fetch;
  rmSync(tempDir, { recursive: true, force: true });
});

function withTenant<R>(tenantId: string, fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

describe("computeWebhookSignature — hmac vector", () => {
  test("matches the known HMAC-SHA256 hex for secret='test-secret', body='{\"a\":1}'", () => {
    const sig = computeWebhookSignature(HMAC_VECTOR_SECRET, HMAC_VECTOR_BODY);
    expect(sig).toBe(HMAC_VECTOR_EXPECTED);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different bodies produce different signatures (sanity)", () => {
    const a = computeWebhookSignature(HMAC_VECTOR_SECRET, '{"a":1}');
    const b = computeWebhookSignature(HMAC_VECTOR_SECRET, '{"a":2}');
    expect(a).not.toBe(b);
  });

  test("different secrets produce different signatures (sanity)", () => {
    const a = computeWebhookSignature("secret-A", HMAC_VECTOR_BODY);
    const b = computeWebhookSignature("secret-B", HMAC_VECTOR_BODY);
    expect(a).not.toBe(b);
  });
});

describe("createWebhook / listWebhooksForTenant", () => {
  test("creates a webhook, masks the secret in the list, and returns plaintext once", () => {
    const created = withTenant("mimule", () =>
      createWebhook({ url: "https://example.com/hook", events: ["incident.created"] }),
    );
    expect(created).not.toBeNull();
    expect(created!.webhook.id).toStartWith("wh_");
    expect(created!.webhook.url).toBe("https://example.com/hook");
    expect(created!.webhook.events).toEqual(["incident.created"]);
    expect(created!.webhook.status).toBe("active");
    expect(created!.secret).toStartWith("whsec_");
    expect(created!.secret.length).toBeGreaterThan(20);

    const list = withTenant("mimule", () => listWebhooksForTenant());
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created!.webhook.id);
    expect(list[0].secretMasked).not.toBe(created!.secret);
    expect(list[0].secretMasked).toContain("…");
  });

  test("rejects invalid url and empty events with an Error", () => {
    expect(() =>
      withTenant("mimule", () => createWebhook({ url: "not-a-url", events: ["x"] })),
    ).toThrow();
    expect(() =>
      withTenant("mimule", () => createWebhook({ url: "https://x.example/", events: [] })),
    ).toThrow();
  });
});

describe("dispatchToWebhook — header + delivery row", () => {
  type Captured = { url: string; init: RequestInit; signatureHeader: string | null };

  function installFetchMock(respond: (req: { url: string; body: string; signature: string | null }) => Response): {
    captured: Captured[];
  } {
    const captured: Captured[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      const headers = new Headers(init?.headers ?? {});
      const signatureHeader = headers.get(__test_only.SIGNATURE_HEADER);
      const body = typeof init?.body === "string" ? init.body : "";
      captured.push({ url, init: init ?? {}, signatureHeader });
      return respond({ url, body, signature: signatureHeader });
    }) as unknown as typeof fetch;
    return { captured };
  }

  test("POSTs JSON, signs with X-CS-Signature, writes a delivery row, updates last_status", async () => {
    const created = withTenant("mimule", () =>
      createWebhook({ url: "https://hook.example/test", events: ["incident.created"] }),
    );
    expect(created).not.toBeNull();

    const { captured } = installFetchMock(() =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const db = getDashboardDb()!;
    const row = db.query(`SELECT * FROM webhooks WHERE id = ?`).get(created!.webhook.id) as {
      id: string; url: string; secret: string; events: string; status: "active" | "disabled";
      created_at: number; last_delivery_at: number | null; last_status: string | null; tenant_id: string | null;
    };
    const res = await dispatchToWebhook(row, "incident.created", { x: 1 });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(captured.length).toBe(1);
    expect(captured[0].url).toBe("https://hook.example/test");
    const expectedSig = computeWebhookSignature(created!.secret, captured[0].init.body as string);
    expect(captured[0].signatureHeader).toBe(expectedSig);
    expect((captured[0].init.body as string).startsWith('{"event":"incident.created"')).toBe(true);

    const delivery = db.query(`SELECT * FROM webhook_deliveries WHERE webhook_id = ?`).get(created!.webhook.id) as {
      status: string; attempts: number; event: string;
    };
    expect(delivery).not.toBeNull();
    expect(delivery.event).toBe("incident.created");
    expect(delivery.attempts).toBe(1);
    expect(delivery.status).toStartWith("ok:");

    const updated = db.query(`SELECT last_status, last_delivery_at FROM webhooks WHERE id = ?`).get(created!.webhook.id) as {
      last_status: string; last_delivery_at: number | null;
    };
    expect(updated.last_status).toStartWith("ok:");
    expect(updated.last_delivery_at).not.toBeNull();
  });

  test("retries once on 500, gives up on 4xx (no retry), records delivery status", async () => {
    const created = withTenant("mimule", () =>
      createWebhook({ url: "https://hook.example/retry", events: ["incident.created"] }),
    );
    expect(created).not.toBeNull();
    const db = getDashboardDb()!;
    const row = db.query(`SELECT * FROM webhooks WHERE id = ?`).get(created!.webhook.id) as {
      id: string; url: string; secret: string; events: string; status: "active" | "disabled";
      created_at: number; last_delivery_at: number | null; last_status: string | null; tenant_id: string | null;
    };

    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return new Response("boom", { status: 503 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const okRes = await dispatchToWebhook(row, "incident.created", { n: 1 });
    expect(call).toBe(2);
    expect(okRes.ok).toBe(true);
    expect(okRes.attempts).toBe(2);

    // 4xx should NOT retry
    call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const failRes = await dispatchToWebhook(row, "incident.created", { n: 2 });
    expect(call).toBe(1);
    expect(failRes.ok).toBe(false);
    expect(failRes.attempts).toBe(1);
    expect(failRes.status).toStartWith("http:404");
  });
});

describe("dispatchEvent — fan-out & active/disabled filtering", () => {
  test("disabled webhook is skipped, no delivery row written", async () => {
    const created = withTenant("mimule", () =>
      createWebhook({ url: "https://hook.example/disabled", events: ["incident.created"] }),
    );
    expect(created).not.toBeNull();
    const db = getDashboardDb()!;
    db.query(`UPDATE webhooks SET status = 'disabled' WHERE id = ?`).run(created!.webhook.id);

    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await dispatchEvent("incident.created", { y: 1 });
    expect(res.dispatched).toBe(0);
    expect(res.ok).toBe(0);
    expect(res.failed).toBe(0);
    expect(called).toBe(0);

    const delivery = db.query(`SELECT * FROM webhook_deliveries`).all();
    expect(delivery.length).toBe(0);
  });

  test("only matching event subscribers are dispatched to", async () => {
    withTenant("mimule", () => createWebhook({ url: "https://hook.example/a", events: ["incident.created"] }));
    withTenant("mimule", () => createWebhook({ url: "https://hook.example/b", events: ["insight.critical"] }));
    withTenant("mimule", () => createWebhook({ url: "https://hook.example/c", events: ["incident.created", "insight.critical"] }));

    const called: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      called.push(url);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await dispatchEvent("incident.created", { z: 1 });
    expect(res.dispatched).toBe(2);
    expect(res.ok).toBe(2);
    expect(called.sort()).toEqual([
      "https://hook.example/a",
      "https://hook.example/c",
    ]);
  });

  test("returns dispatched=0 when DB is disabled (no-op)", async () => {
    closeDashboardDb();
    const res = await dispatchEvent("incident.created", { x: 1 });
    expect(res).toEqual({ dispatched: 0, ok: 0, failed: 0 });
  });
});
