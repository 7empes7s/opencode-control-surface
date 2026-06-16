import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleApi } from "./router.ts";

const TEST_OPERATOR_TOKEN = "system-config-test-token";
let previousOperatorToken: string | undefined;

function resetRateLimitMap(): void {
  (globalThis as unknown as { __rateLimitMap?: Record<string, number> }).__rateLimitMap = {};
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "x-real-ip": "system-config-test",
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

describe("GET /api/system-config/current", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with system config data", async () => {
    const response = await handleApi(
      request("/api/system-config"),
      new URL("http://127.0.0.1:3000/api/system-config"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.sourceStatus).toBe("object");
    expect(body.data).toBeDefined();
    expect(typeof (body.data as any).config).toBe("object");
  });
});

describe("POST /api/system-config/update", () => {
  beforeEach(() => {
    resetRateLimitMap();
    previousOperatorToken = process.env.OPERATOR_TOKEN;
    process.env.OPERATOR_TOKEN = TEST_OPERATOR_TOKEN;
  });

  afterEach(() => {
    if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousOperatorToken;
  });

  test("returns 200 when updating system config", async () => {
    const response = await handleApi(
      request("/api/system-config", {
        method: "PUT",
        body: JSON.stringify({ 
          config: {
            financeAgent: {
              enabled: true,
              processingTimeout: 300000
            }
          }
        }),
        headers: { "content-type": "application/json", "x-operator-token": TEST_OPERATOR_TOKEN },
      }),
      new URL("http://127.0.0.1:3000/api/system-config"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.sourceStatus).toBe("object");
    expect(body.data).toBeDefined();
    expect((body.data as any).success).toBe(true);
  });
});

describe("GET /api/system-config/history", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with system config history", async () => {
    const response = await handleApi(
      request("/api/system-config/history"),
      new URL("http://127.0.0.1:3000/api/system-config/history"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.sourceStatus).toBe("object");
    expect(body.data).toBeDefined();
    expect(Array.isArray((body.data as any).history)).toBe(true);
  });
});
