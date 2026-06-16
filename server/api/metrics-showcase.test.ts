import { beforeEach, describe, expect, test } from "bun:test";
import { handleApi } from "./router.ts";

function resetRateLimitMap(): void {
  (globalThis as unknown as { __rateLimitMap?: Record<string, [number, number]> }).__rateLimitMap = {};
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "x-real-ip": "metrics-showcase-test",
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

describe("GET /api/metrics/showcase", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with re-framed headline", async () => {
    const response = await handleApi(
      request("/api/metrics/showcase"),
      new URL("http://127.0.0.1:3000/api/metrics/showcase"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const headline = body.data.headline;

    expect(headline.headlineSentence).toBeDefined();
    expect(typeof headline.headlineSentence).toBe("string");
    expect(headline.selfCorrectionRate).toBeDefined();
    expect(typeof headline.selfCorrectionRate).toBe("number");
    
    // Explicitly check for REMOVAL of buildSuccessRate
    expect(headline.buildSuccessRate).toBeUndefined();

    // Check builds detail block still present with successRate
    expect(body.data.builds).toBeDefined();
    expect(body.data.builds.successRate).toBeDefined();
    expect(typeof body.data.builds.successRate).toBe("number");
  });
});
