import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
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

describe("router auth gating", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;
  let previousOperatorToken: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    resetRateLimitMap();
    tempDir = mkdtempSync(join(tmpdir(), "router-auth-gating-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    previousOperatorToken = process.env.OPERATOR_TOKEN;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    process.env.OPERATOR_TOKEN = "test-token";
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousOperatorToken;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const gatedRoutes = [
    "/api/home",
    "/api/product-health",
    "/api/metrics/showcase",
    "/api/governance/users",
    "/api/data-explorer/tables",
    "/api/litellm/config",
    "/api/gateway/ledger",
    "/api/cost",
    "/api/traces",
    "/api/reasoner/incidents",
    "/api/builder/projects",
    "/api/events",
  ];

  const machineSurfaceRoutes = [
    "/api/v1/insights",
    "/api/v1/agents",
    "/api/v1/audit",
    "/api/v1/trust-score",
    "/api/v1/cost",
  ];

  const publicRoutes = [
    "/api/auth/status",
    "/api/public-status",
    "/api/version",
    "/v1/models",
  ];

  test("rejects newly gated routes without credentials", async () => {
    for (const path of gatedRoutes) {
      const response = await handleApi(request(path), new URL(`http://127.0.0.1:3000${path}`));
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
  });

  test("allows valid operator-token requests through newly gated routes", async () => {
    for (const path of gatedRoutes) {
      const response = await handleApi(
        request(path, { headers: { "x-operator-token": "test-token" } }),
        new URL(`http://127.0.0.1:3000${path}`),
      );
      expect({ path, unauthorized: response.status === 401 }).toEqual({ path, unauthorized: false });
    }
  });

  test("lets machine-surface handlers authenticate operator tokens", async () => {
    for (const path of machineSurfaceRoutes) {
      const anonymousResponse = await handleApi(request(path), new URL(`http://127.0.0.1:3000${path}`));
      expect({ path, status: anonymousResponse.status }).toEqual({ path, status: 401 });

      const authenticatedResponse = await handleApi(
        request(path, { headers: { "x-operator-token": "test-token" } }),
        new URL(`http://127.0.0.1:3000${path}`),
      );
      expect({ path, unauthorized: authenticatedResponse.status === 401 }).toEqual({ path, unauthorized: false });
    }
  });

  test("lets the chat completions handler reject non-gateway bearer tokens", async () => {
    const response = await handleApi(
      request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer bogus-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      new URL("http://127.0.0.1:3000/v1/chat/completions"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "This gateway requires an agent key. Create one on /gateway.",
    });
  });

  test("keeps the public licensing alias reachable without operator auth", async () => {
    const path = "/v1/licensing";
    const response = await handleApi(request(path), new URL(`http://127.0.0.1:3000${path}`));
    expect(response.status).not.toBe(401);
  });

  test("keeps the explicit public sample reachable without credentials", async () => {
    for (const path of publicRoutes) {
      const response = await handleApi(request(path), new URL(`http://127.0.0.1:3000${path}`));
      expect({ path, unauthorized: response.status === 401 }).toEqual({ path, unauthorized: false });
    }
  });
});
