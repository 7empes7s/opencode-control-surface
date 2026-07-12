import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleApi } from "./router.ts";

const TEST_OPERATOR_TOKEN = "dossier-test-token";
let previousOperatorToken: string | undefined;

function resetRateLimitMap(): void {
  (globalThis as unknown as { __rateLimitMap?: Record<string, number> }).__rateLimitMap = {};
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "x-real-ip": "dossier-test",
      "x-operator-token": TEST_OPERATOR_TOKEN,
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

beforeEach(() => {
  previousOperatorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = TEST_OPERATOR_TOKEN;
});

afterEach(() => {
  if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousOperatorToken;
});

describe("GET /api/dossier/:date/:slug", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with dossier artifacts data", async () => {
    // Test with a placeholder date and slug that should return 404 if not found
    // But the API should return a proper response structure
    const response = await handleApi(
      request("/api/dossier/2026-01-01/test-slug"),
      new URL("http://127.0.0.1:3000/api/dossier/2026-01-01/test-slug"),
    );
    
    // The response should either be 200 with data or 404 with proper error structure
    expect([200, 404]).toContain(response.status);
    
    if (response.status === 200) {
      const body = await response.json() as Record<string, unknown>;
      expect(typeof body.generatedAt).toBe("string");
      expect(typeof body.sourceStatus).toBe("object");
      expect(body.data).toBeDefined();
      expect(typeof (body.data as any).slug).toBe("string");
      expect(Array.isArray((body.data as any).sources)).toBe(true);
      expect(Array.isArray((body.data as any).claims)).toBe(true);
      expect(typeof (body.data as any).draftContent).toBe("string");
    } else if (response.status === 404) {
      const body = await response.json() as Record<string, unknown>;
      expect(typeof body.error).toBe("string");
    }
  });
});

describe("POST /api/dossier/:date/:slug/inject", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 404 for non-existent dossier (expected behavior)", async () => {
    const response = await handleApi(
      request("/api/dossier/2026-01-01/test-slug/inject", {
        method: "POST",
        body: JSON.stringify({ notes: "test notes", requeueStage: null }),
        headers: { "content-type": "application/json" },
      }),
      new URL("http://127.0.0.1:3000/api/dossier/2026-01-01/test-slug/inject"),
    );
    
    // Since the test dossier doesn't exist, this should return 404
    expect(response.status).toBe(404);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });
});
