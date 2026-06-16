import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "./router.ts";
import { closeObservabilityDb } from "../db/observability.ts";

let tempDir: string;
let previousObservabilityDbPath: string | undefined;
let previousOperatorToken: string | undefined;

function resetRateLimitMap(): void {
  (globalThis as unknown as { __rateLimitMap?: Record<string, number> }).__rateLimitMap = {};
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: {
      "x-real-ip": "finance-intel-test",
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

beforeEach(() => {
  resetRateLimitMap();
  closeObservabilityDb();
  tempDir = mkdtempSync(join(tmpdir(), "finance-intel-test-"));
  previousObservabilityDbPath = process.env.OBSERVABILITY_DB_PATH;
  previousOperatorToken = process.env.OPERATOR_TOKEN;
  process.env.OBSERVABILITY_DB_PATH = join(tempDir, "observability.sqlite");
});

afterEach(() => {
  closeObservabilityDb();
  if (previousObservabilityDbPath === undefined) delete process.env.OBSERVABILITY_DB_PATH;
  else process.env.OBSERVABILITY_DB_PATH = previousObservabilityDbPath;
  if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousOperatorToken;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /api/finance-intel/runs", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with finance runs data", async () => {
    const response = await handleApi(
      request("/api/finance-intel/runs"),
      new URL("http://127.0.0.1:3000/api/finance-intel/runs"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.sourceStatus).toBe("object");
    expect(Array.isArray(body.data)).toBe(true);
    if (Array.isArray(body.data) && body.data.length > 0) {
      const run = body.data[0];
      expect(typeof run.id).toBe("string");
      expect(typeof run.runAt).toBe("string");
      expect(typeof run.articleCount).toBe("number");
      expect(typeof run.avgProcessingTimeMs).toBe("number");
      expect(typeof run.status).toBe("string");
    }
  });
});

describe("GET /api/finance-intel/enrichments", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with finance enrichments data", async () => {
    const response = await handleApi(
      request("/api/finance-intel/enrichments"),
      new URL("http://127.0.0.1:3000/api/finance-intel/enrichments"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    if (Array.isArray(body.data) && body.data.length > 0) {
      const enrichment = body.data[0];
      expect(typeof enrichment.id).toBe("string");
      expect(typeof enrichment.articleSlug).toBe("string");
      expect(typeof enrichment.ticker).toBe("string");
      expect(typeof enrichment.confidence).toBe("string");
      expect(typeof enrichment.enrichedAt).toBe("string");
    }
  });
});

describe("GET /api/finance-intel/portfolio-config", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with portfolio config data", async () => {
    const response = await handleApi(
      request("/api/finance-intel/portfolio-config"),
      new URL("http://127.0.0.1:3000/api/finance-intel/portfolio-config"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.data).toBe("object");
      expect(Array.isArray((body.data as any).portfolio)).toBe(true);
  });
});

describe("POST /api/finance-intel/portfolio-config", () => {
  beforeEach(() => {
    resetRateLimitMap();
    process.env.OPERATOR_TOKEN = "test-token";
  });

  test("returns 200 when updating portfolio config", async () => {
    const response = await handleApi(
      request("/api/finance-intel/portfolio-config", {
        method: "POST",
        body: JSON.stringify({ name: "Test Portfolio", watchlist: ["AAPL", "GOOGL", "MSFT"] }),
        headers: { "content-type": "application/json", "x-operator-token": "test-token" },
      }),
      new URL("http://127.0.0.1:3000/api/finance-intel/portfolio-config"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
  });
});

describe("POST /api/finance-intel/trigger-analysis", () => {
  beforeEach(() => {
    resetRateLimitMap();
    process.env.OPERATOR_TOKEN = "test-token";
  });

  test("returns 200 when triggering analysis", async () => {
    const response = await handleApi(
      request("/api/finance-intel/trigger-analysis", {
        method: "POST",
        body: JSON.stringify({ portfolio: ["AAPL"] }),
        headers: { "content-type": "application/json", "x-operator-token": "test-token" },
      }),
      new URL("http://127.0.0.1:3000/api/finance-intel/trigger-analysis"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
  });
});

describe("GET /api/finance-intel/stats", () => {
  beforeEach(() => {
    resetRateLimitMap();
  });

  test("returns 200 with finance stats", async () => {
    const response = await handleApi(
      request("/api/finance-intel/stats"),
      new URL("http://127.0.0.1:3000/api/finance-intel/stats"),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.data).toBe("object");
    expect(typeof (body.data as any).totalRuns).toBe("number");
    expect(typeof (body.data as any).totalEnrichments).toBe("number");
    expect(typeof (body.data as any).avgDurationMs).toBe("number");
    expect(typeof (body.data as any).activePortfolios).toBe("number");
  });
});
