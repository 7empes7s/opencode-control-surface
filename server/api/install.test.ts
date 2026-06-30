import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { collectInstallStatus, installStatusHandler } from "./install.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevOperatorToken: string | undefined;
let prevTelegramToken: string | undefined;
let prevTelegramChat: string | undefined;
let prevLiteLlm: string | undefined;
let prevSentinelPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "install-status-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevOperatorToken = process.env.OPERATOR_TOKEN;
  prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  prevTelegramChat = process.env.TELEGRAM_CHAT_ID;
  prevLiteLlm = process.env.LITELLM_MASTER_KEY;
  prevSentinelPath = process.env.SENTINEL_HEALTH_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "install-test-operator-secret";
  process.env.TELEGRAM_BOT_TOKEN = "install-test-telegram-secret";
  process.env.TELEGRAM_CHAT_ID = "install-test-chat-secret";
  process.env.LITELLM_MASTER_KEY = "install-test-litellm-secret";
  process.env.SENTINEL_HEALTH_PATH = join(tempDir, "missing-product-health.json");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevOperatorToken;
  if (prevTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
  if (prevTelegramChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = prevTelegramChat;
  if (prevLiteLlm === undefined) delete process.env.LITELLM_MASTER_KEY;
  else process.env.LITELLM_MASTER_KEY = prevLiteLlm;
  if (prevSentinelPath === undefined) delete process.env.SENTINEL_HEALTH_PATH;
  else process.env.SENTINEL_HEALTH_PATH = prevSentinelPath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("install status", () => {
  test("returns checklist shape with presence-only secret reporting", async () => {
    const status = collectInstallStatus();
    expect(status.generatedAt).toBeGreaterThan(0);
    expect(status.checks.some((check) => check.id === "operator-token" && check.status === "pass")).toBe(true);
    expect(status.checks.some((check) => check.id === "required-secrets" && check.status === "pass")).toBe(true);
    expect(status.checks.some((check) => check.id === "tunnels-up")).toBe(true);
    expect(status.checks.some((check) => check.id === "sentinel-running")).toBe(true);
    expect(status.checks.some((check) => check.id === "scheduler-running")).toBe(true);
    expect(status.secrets).toHaveLength(3);
    expect(status.secrets.every((secret) => secret.present)).toBe(true);

    const body = JSON.stringify(status);
    expect(body).not.toContain("install-test-operator-secret");
    expect(body).not.toContain("install-test-telegram-secret");
    expect(body).not.toContain("install-test-chat-secret");
    expect(body).not.toContain("install-test-litellm-secret");
  });

  test("handler wraps the status in the standard API envelope", async () => {
    const res = installStatusHandler();
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: { checks?: unknown[]; secrets?: unknown[] } };
    expect(Array.isArray(body.data?.checks)).toBe(true);
    expect(Array.isArray(body.data?.secrets)).toBe(true);
  });
});
