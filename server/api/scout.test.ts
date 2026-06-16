import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleApi } from "./router.ts";

const originalFetch = globalThis.fetch;

function resetRateLimitMap(): void {
  (globalThis as unknown as { __rateLimitMap?: Record<string, number> }).__rateLimitMap = {};
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "x-real-ip": "scout-test",
      "x-operator-token": "test-token",
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

describe("GET /api/scout/runs", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with scout runs data", async () => {
    const response = await handleApi(
      request("/api/scout/runs"),
      new URL("http://127.0.0.1:3000/api/scout/runs"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.sourceStatus).toBe("object");
    expect(body.data).toBeDefined();
    expect(Array.isArray((body.data as any).runs)).toBe(true);
    if (Array.isArray((body.data as any).runs) && (body.data as any).runs.length > 0) {
      const run = (body.data as any).runs[0];
      expect(typeof run.id).toBe("string");
      expect(typeof run.runAt).toBe("string");
      expect(Array.isArray(run.topics)).toBe(true);
      expect(typeof run.trigger).toBe("string");
    }
  });
});

describe("GET /api/scout/config", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with scout config data", async () => {
    const response = await handleApi(
      request("/api/scout/config"),
      new URL("http://127.0.0.1:3000/api/scout/config"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.data).toBe("object");
    expect(typeof (body.data as any).enabled).toBe("boolean");
    expect(typeof (body.data as any).frequency).toBe("string");
  });
});

describe("PUT /api/scout/config", () => {
  beforeEach(() => {
    resetRateLimitMap();
    process.env.OPERATOR_TOKEN = "test-token";
  });

  test("returns 200 when updating scout config", async () => {
    const response = await handleApi(
      request("/api/scout/config", {
        method: "PUT",
        body: JSON.stringify({ 
          enabled: true,
          frequency: "daily",
          verticals: ["ai", "finance"],
          maxTopicsPerRun: 5,
          minNoveltyScore: 0.5,
          minRecencyHours: 24,
          autoQueueThreshold: 0.8
        }),
        headers: { "content-type": "application/json" },
      }),
      new URL("http://127.0.0.1:3000/api/scout/config"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.sourceStatus).toBe("object");
    expect(body.data).toBeDefined();
    expect((body.data as any).success).toBe(true);
  });
});

describe("POST /api/scout/trigger", () => {
  beforeEach(() => {
    resetRateLimitMap();
    process.env.OPERATOR_TOKEN = "test-token";
    const mockFetch = Object.assign(
      async () => Response.json({ ok: true }),
      { preconnect: () => {} }
    ) as typeof fetch;
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns 200 when triggering scout run", async () => {
    const response = await handleApi(
      request("/api/scout/trigger", {
        method: "POST",
        body: JSON.stringify({ reason: "manual test" }),
        headers: { "content-type": "application/json" },
      }),
      new URL("http://127.0.0.1:3000/api/scout/trigger"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.sourceStatus).toBe("object");
    expect(body.data).toBeDefined();
    expect((body.data as any).success).toBe(true);
  });
});
