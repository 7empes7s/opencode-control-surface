import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readActionAudit } from "../db/writer.ts";
import { handleApi } from "./router.ts";
import { buildPolicyRegistry } from "./policyRegistry.ts";
import { seedPlaybooks } from "../reasoner/playbooks.ts";
import { autoApplySafeInsights } from "../insights/autoapply.ts";
import { upsertInsight, getInsight } from "../insights/store.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "policy-registry-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  seedPlaybooks(getDashboardDb()!);
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  rmSync(tempDir, { recursive: true, force: true });
});

function req(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

describe("policy registry and autoapply policy", () => {
  test("registry includes seed auto actions and reasoner playbooks", async () => {
    const registry = await buildPolicyRegistry();
    expect(registry.some((row) => row.key === "start-job:model-health:all" && row.riskTier === "auto")).toBe(true);
    expect(registry.some((row) => row.key === "start-job:infra:doctor-log-rotate" && row.riskTier === "auto")).toBe(true);
    expect(registry.some((row) => row.key === "reasoner-remediate:pass-timeout" && row.source === "reasoner")).toBe(true);
  });

  test("set-tier is token gated, validated, audited, and reflected in registry", async () => {
    const noTokenReq = req("/api/actions/execute", {
      method: "POST",
      body: JSON.stringify({
        actionId: "mutate-policy:autoapply:start-job:model-health:all:set-tier",
        confirmed: true,
        reason: "test",
        params: { tier: "off" },
      }),
    });
    const noToken = await handleApi(noTokenReq, new URL(noTokenReq.url));
    expect(noToken.status).toBe(401);

    const unknownReq = req("/api/actions/execute", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({
        actionId: "mutate-policy:autoapply:unknown-action:set-tier",
        confirmed: true,
        reason: "test",
        params: { tier: "off" },
      }),
    });
    const unknown = await handleApi(unknownReq, new URL(unknownReq.url));
    expect(unknown.status).toBe(400);

    const setReq = req("/api/actions/execute", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({
        actionId: "mutate-policy:autoapply:start-job:model-health:all:set-tier",
        confirmed: true,
        reason: "test policy change",
        params: { tier: "off" },
      }),
    });
    const setRes = await handleApi(setReq, new URL(setReq.url));
    expect(setRes.status).toBe(200);

    const registry = await buildPolicyRegistry();
    expect(registry.find((row) => row.key === "start-job:model-health:all")?.riskTier).toBe("off");
    expect(readActionAudit({ actionKind: "mutate-policy.autoapply" }).some((row) => row.resultStatus === "success")).toBe(true);
  });

  test("off policy blocks auto-apply", async () => {
    const setReq = req("/api/actions/execute", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({
        actionId: "mutate-policy:autoapply:start-job:model-health:all:set-tier",
        confirmed: true,
        reason: "disable for test",
        params: { tier: "off" },
      }),
    });
    await handleApi(setReq, new URL(setReq.url));

    const insight = upsertInsight({
      id: "insight-auto-off",
      sourceKey: "ops:auto-off",
      domain: "ops",
      severity: "high",
      title: "Auto off",
      plainSummary: "A safe action exists, but policy is off.",
      confidence: 0.9,
      evidenceRefs: [],
      actionDescriptorId: "start-job:model-health:all",
      manualPageHref: "/models",
      createdAt: Date.now(),
    });

    const applied = await autoApplySafeInsights([insight!]);
    expect(applied).toBe(0);
    expect(getInsight("insight-auto-off")?.status).toBe("open");
  });
});
