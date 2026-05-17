import { beforeEach, describe, expect, test } from "bun:test";
import { handleApi } from "./router.ts";

function resetRateLimitMap(): void {
  (globalThis as unknown as { __rateLimitMap?: Record<string, [number, number]> }).__rateLimitMap = {};
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "x-real-ip": "router-test",
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

describe("router rate limiting", () => {
  beforeEach(() => {
    resetRateLimitMap();
    process.env.OPERATOR_TOKEN = "test-token";
  });

  test("does not throttle repeated read-only API requests", async () => {
    for (let index = 0; index < 35; index += 1) {
      const response = await handleApi(request("/api/auth/status"), new URL("http://127.0.0.1:3000/api/auth/status"));
      expect(response.status).not.toBe(429);
    }
  });

  test("still throttles repeated mutating API requests", async () => {
    let response = new Response(null, { status: 500 });
    for (let index = 0; index < 31; index += 1) {
      response = await handleApi(
        request("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "wrong-token" }),
        }),
        new URL("http://127.0.0.1:3000/api/auth/session"),
      );
    }

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });
});
