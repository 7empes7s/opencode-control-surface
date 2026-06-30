import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import {
  SAFE_AUTO_ACTIONS,
  _setAutoApplyNowForTests,
  autoApplySafeInsights,
  isSafeAutoAction,
  previewAutoApplyCandidates,
  riskTierFor,
} from "./autoapply.ts";
import { signatureFor, upsertAiAnalysis } from "./ai.ts";
import { getInsight, upsertInsight } from "./store.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "autoapply-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  _setAutoApplyNowForTests(() => 1_700_000_000_000);
});

afterEach(() => {
  _setAutoApplyNowForTests(null);
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  rmSync(tempDir, { recursive: true, force: true });
});

function savePolicy(value: unknown) {
  getDashboardDb()!.query(`
    INSERT OR REPLACE INTO system_configs (key, value_json, updated_at, updated_by)
    VALUES ('autoapply.policy', ?, ?, 'test')
  `).run(JSON.stringify(value), 1_700_000_000_000);
}

function safeInsight(id: string, sourceKey: string) {
  return upsertInsight({
    id,
    sourceKey,
    domain: "ops",
    severity: "high",
    title: "Safe action candidate",
    plainSummary: "A seeded auto-apply candidate.",
    confidence: 0.91,
    evidenceRefs: [],
    actionDescriptorId: "start-job:model-health:all",
    manualPageHref: "/models",
    createdAt: 1_700_000_000_000,
  })!;
}

function seedAiAnalysis(insight: NonNullable<ReturnType<typeof safeInsight>>, confidence = 0.82) {
  upsertAiAnalysis({
    signature: signatureFor(insight),
    insightId: insight.id,
    summary: "The finding has enough AI confidence for safe automation.",
    rootCause: "A test root cause was identified.",
    recommendedAction: "Run the safe remediation.",
    confidence,
    model: "test-model",
    generatedAt: 1_700_000_000_000,
  });
}

describe("insights auto-apply: risk tiering", () => {
  test("the safe allowlist is intentionally minimal and excludes mutating/customer-facing actions", () => {
    expect(SAFE_AUTO_ACTIONS.has("start-job:model-health:all")).toBe(true);
    expect(SAFE_AUTO_ACTIONS.has("start-job:infra:doctor-log-rotate")).toBe(true);
    // The dangerous ones must NEVER be auto-applied.
    expect(SAFE_AUTO_ACTIONS.has("start-job:service:newsbites")).toBe(false);
    expect(SAFE_AUTO_ACTIONS.has("start-job:service:vast-tunnel")).toBe(false);
    expect(SAFE_AUTO_ACTIONS.has("start-job:gateway:route-healthiest")).toBe(false);
    expect(SAFE_AUTO_ACTIONS.has("mutate-policy:model:x:block")).toBe(false);
    expect(SAFE_AUTO_ACTIONS.size).toBe(2);
  });

  test("isSafeAutoAction only matches the allowlist and cooldown-clear pattern", () => {
    expect(isSafeAutoAction("start-job:model-health:all")).toBe(true);
    expect(isSafeAutoAction("start-job:infra:doctor-log-rotate")).toBe(true);
    expect(isSafeAutoAction("mutate-policy:model:editorial-heavy:cooldown-clear")).toBe(true);
    expect(isSafeAutoAction("start-job:service:newsbites")).toBe(false);
    expect(isSafeAutoAction("mutate-policy:model:editorial-heavy:block")).toBe(false);
    expect(isSafeAutoAction(null)).toBe(false);
    expect(isSafeAutoAction(undefined)).toBe(false);
  });

  test("riskTierFor classifies findings", () => {
    expect(riskTierFor({ actionDescriptorId: "start-job:model-health:all" })).toBe("auto");
    expect(riskTierFor({ actionDescriptorId: "mutate-policy:model:editorial-heavy:cooldown-clear" })).toBe("auto");
    expect(riskTierFor({ actionDescriptorId: "start-job:service:vast-tunnel" })).toBe("review");
    expect(riskTierFor({ actionDescriptorId: null })).toBe("none");
  });

  test("preview returns candidates without executing them", () => {
    const insight = safeInsight("insight-preview", "ops:preview");
    seedAiAnalysis(insight, 0.86);

    const rows = previewAutoApplyCandidates([insight]);

    expect(rows).toEqual([{
      insightId: "insight-preview",
      sourceKey: "ops:preview",
      actionDescriptorId: "start-job:model-health:all",
      tier: "auto",
      wouldApply: true,
      reason: "policy key start-job:model-health:all allows auto; AI confidence 0.86 meets threshold 0.75",
    }]);
    expect(getInsight("insight-preview")?.status).toBe("open");
  });

  test("preview waits for AI analysis before auto-applying a safe action", () => {
    const insight = safeInsight("insight-no-ai", "ops:no-ai");

    const rows = previewAutoApplyCandidates([insight]);

    expect(rows[0].wouldApply).toBe(false);
    expect(rows[0].reason).toContain("waiting for AI analysis confidence");
  });

  test("low AI confidence prevents automatic execution", async () => {
    const insight = safeInsight("insight-low-ai", "ops:low-ai");
    seedAiAnalysis(insight, 0.62);

    const applied = await autoApplySafeInsights([insight]);
    const preview = previewAutoApplyCandidates([insight]);

    expect(applied).toBe(0);
    expect(preview[0].wouldApply).toBe(false);
    expect(preview[0].reason).toContain("below auto-apply threshold");
    expect(getInsight("insight-low-ai")?.status).toBe("open");
  });

  test("rate limit blocks the next auto-apply within the trailing hour", async () => {
    savePolicy({ tiers: {}, maxAutoAppliesPerHour: 1, circuitBreakerThreshold: 3, circuitBreakerWindowMs: 60 * 60_000 });
    writeActionAudit({
      actor: "system",
      actionKind: "insights.auto-apply",
      targetType: "insight",
      targetId: "old",
      risk: "low",
      request: { trigger: "auto", sourceKey: "ops:old" },
      resultStatus: "success",
      result: "already applied",
    });
    const insight = safeInsight("insight-rate", "ops:rate");

    const applied = await autoApplySafeInsights([insight]);
    const preview = previewAutoApplyCandidates([insight]);

    expect(applied).toBe(0);
    expect(preview[0].wouldApply).toBe(false);
    expect(preview[0].reason).toContain("rate limit reached");
    expect(getInsight("insight-rate")?.status).toBe("open");
  });

  test("circuit breaker trips after repeated failures and emits a finding", async () => {
    savePolicy({ tiers: {}, maxAutoAppliesPerHour: 10, circuitBreakerThreshold: 2, circuitBreakerWindowMs: 60 * 60_000 });
    for (let i = 0; i < 2; i++) {
      writeActionAudit({
        actor: "system",
        actionKind: "insights.auto-apply",
        targetType: "insight",
        targetId: `failed-${i}`,
        risk: "low",
        request: { trigger: "auto", sourceKey: "ops:flap" },
        resultStatus: "failed",
        result: "failed",
      });
    }
    const insight = safeInsight("insight-flap", "ops:flap");

    const applied = await autoApplySafeInsights([insight]);

    expect(applied).toBe(0);
    expect(getInsight("insight-flap")?.status).toBe("open");
    expect(getInsight("insight_autoapply_flapping_ops_flap")?.sourceKey).toBe("security:autoapply-flapping:ops:flap");
  });
});
