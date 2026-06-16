import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { handleApi } from "./router.ts";
import { publicStatusHandler } from "./status.ts";

let tempDir: string;
let prevHealth: string | undefined;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "status-test-"));
  prevHealth = process.env.SENTINEL_HEALTH_PATH;
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevHealth === undefined) delete process.env.SENTINEL_HEALTH_PATH;
  else process.env.SENTINEL_HEALTH_PATH = prevHealth;
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function writeHealth(contents: Record<string, unknown>): string {
  const path = join(tempDir, "product-health.json");
  writeFileSync(path, JSON.stringify(contents), "utf8");
  process.env.SENTINEL_HEALTH_PATH = path;
  return path;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: { "x-real-ip": "status-test", ...(init.headers as Record<string, string> | undefined ?? {}) },
  });
}

describe("GET /api/public-status", () => {
  test("returns 200 with no auth required", async () => {
    writeHealth({
      score: 95,
      fails: 0,
      warns: 1,
      findings: [],
      checkedAt: Math.floor(Date.now() / 1000),
      checkedAtISO: new Date().toISOString(),
      agents: { opencode: { ok: true }, codex: { ok: true } },
    });

    const res = await handleApi(
      request("/api/public-status"),
      new URL("http://127.0.0.1:3000/api/public-status"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toContain("application/json");
    const body = await res.json() as {
      status: string;
      score: number;
      checkedAt: string;
      uptimeSec: number;
      agents: Array<{ name: string; ok: boolean }>;
      services: unknown[];
      generatedAt: string;
    };
    expect(body.status).toBe("operational");
    expect(body.score).toBe(95);
    expect(typeof body.checkedAt).toBe("string");
    expect(typeof body.uptimeSec).toBe("number");
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.agents).toHaveLength(2);
    expect(body.agents.find((a) => a.name === "opencode")?.ok).toBe(true);
    expect(Array.isArray(body.services)).toBe(true);
    expect(body.services.length).toBe(0);
    expect(typeof body.generatedAt).toBe("string");
  });

  test("degraded mapping (score 60-89) returns 'degraded'", async () => {
    writeHealth({
      score: 72,
      fails: 1,
      warns: 2,
      findings: [{ id: "agent-codex-roundtrip", status: "warn", severity: "warn" }],
      checkedAt: Math.floor(Date.now() / 1000),
      agents: { codex: { ok: false } },
    });

    const body = await (await handleApi(
      request("/api/public-status"),
      new URL("http://127.0.0.1:3000/api/public-status"),
    )).json() as { status: string; score: number };
    expect(body.status).toBe("degraded");
    expect(body.score).toBe(72);
  });

  test("down mapping (score <60) returns 'down'", async () => {
    writeHealth({
      score: 35,
      fails: 4,
      warns: 6,
      findings: [{ id: "/", status: "fail", severity: "high" }],
      checkedAt: Math.floor(Date.now() / 1000),
      agents: { opencode: { ok: false } },
    });

    const body = await (await handleApi(
      request("/api/public-status"),
      new URL("http://127.0.0.1:3000/api/public-status"),
    )).json() as { status: string; score: number };
    expect(body.status).toBe("down");
    expect(body.score).toBe(35);
  });

  test("missing sentinel file returns degraded with score null and no agents", async () => {
    process.env.SENTINEL_HEALTH_PATH = join(tempDir, "does-not-exist.json");
    const body = await (await handleApi(
      request("/api/public-status"),
      new URL("http://127.0.0.1:3000/api/public-status"),
    )).json() as { status: string; score: number | null; agents: unknown[]; checkedAt: string | null };
    expect(body.status).toBe("degraded");
    expect(body.score).toBeNull();
    expect(body.agents).toEqual([]);
    expect(body.checkedAt).toBeNull();
  });

  test("direct publicStatusHandler returns valid payload (no router/auth in path)", async () => {
    writeHealth({
      score: 100,
      fails: 0,
      warns: 0,
      findings: [],
      checkedAt: Math.floor(Date.now() / 1000),
      agents: { a: { ok: true } },
    });
    const res = publicStatusHandler();
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("operational");
  });
});
