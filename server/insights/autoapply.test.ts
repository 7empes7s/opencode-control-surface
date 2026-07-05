import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import {
  SAFE_AUTO_ACTIONS,
  SKIPPED_NO_ROLLBACK_REASON,
  _setAutoApplyNowForTests,
  autoApplySafeInsights,
  isSafeAutoAction,
  previewAutoApplyCandidates,
  riskTierFor,
} from "./autoapply.ts";
import {
  AUTO_ROLLBACK_AFFORDANCES,
  COOLDOWN_CLEAR_POLICY_KEY,
  PASS_TIMEOUT_RETRY_POLICY_KEY,
  loadAutoApplyPolicy,
  rollbackAffordanceForAction,
  tierForAction,
} from "./autoapplyPolicy.ts";
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

function safeInsight(id: string, sourceKey: string, actionDescriptorId = "start-job:model-health:all") {
  return upsertInsight({
    id,
    sourceKey,
    domain: "ops",
    severity: "high",
    title: "Safe action candidate",
    plainSummary: "A seeded auto-apply candidate.",
    confidence: 0.91,
    evidenceRefs: [],
    actionDescriptorId,
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

  test("guardrail values are unchanged by SPEC 10 (rate limit / breaker / confidence)", () => {
    const policy = loadAutoApplyPolicy();
    expect(policy.maxAutoAppliesPerHour).toBe(10);
    expect(policy.circuitBreakerThreshold).toBe(3);
    expect(policy.circuitBreakerWindowMs).toBe(60 * 60_000);
    expect(policy.minAiConfidenceForAutoApply).toBe(0.75);
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

// ── SPEC 10 (ULTRAPLAN P2.4): deliberate auto-apply expansion ────────────────
// One promotion survived implementation verification (the pass-timeout retry
// family); the other three orchestrator candidates were refused with evidence.
// See docs/AUTOAPPLY_PROMOTION_REVIEW.md.

describe("SPEC 10: pass-timeout family tier resolution", () => {
  test("reasoner-remediate:pass-timeout:* resolves to the auto tier by default", () => {
    expect(tierForAction("reasoner-remediate:pass-timeout:wf-1:pass-1")).toBe("auto");
    expect(tierForAction("reasoner-remediate:pass-timeout:wf-1:pass-1:ri-9")).toBe("auto");
    expect(riskTierFor({ actionDescriptorId: "reasoner-remediate:pass-timeout:wf-2:p" })).toBe("auto");
    // The bare normalized key (used by the policy registry / set-tier UI, never
    // executable — it has no workflow id) reports the family default too.
    expect(tierForAction(PASS_TIMEOUT_RETRY_POLICY_KEY)).toBe("auto");
  });

  test("other reasoner playbooks stay review tier", () => {
    expect(tierForAction("reasoner-remediate:agent-stalled:wf-1:pass-1")).toBe("review");
    expect(tierForAction("reasoner-remediate:codex-exhausted:wf-1:pass-1")).toBe("review");
    expect(tierForAction("reasoner-remediate:no-result-file:wf-1:pass-1")).toBe("review");
    expect(tierForAction("reasoner-remediate:validation-failed:wf-1:pass-1")).toBe("review");
  });

  test("an operator policy override still beats the promoted default", () => {
    savePolicy({ tiers: { [PASS_TIMEOUT_RETRY_POLICY_KEY]: "off" } });
    expect(tierForAction("reasoner-remediate:pass-timeout:wf-1:pass-1")).toBe("off");
  });

  test("the refused SPEC-10 candidates stay review tier", () => {
    // Refused after implementation verification (see the review doc):
    // /doctor/scan mutates pipeline state; the mimule services are not even in
    // the execute allowlist and the restart branch records no before/after state.
    expect(tierForAction("start-job:doctor:scan")).toBe("review");
    expect(tierForAction("start-job:service:mimule-overseer")).toBe("review");
    expect(tierForAction("start-job:service:mimule-orchestrator")).toBe("review");
    // Refused by decision (never auto): ack honesty, operator-off tunnel,
    // production routing, governance-sensitive policy mutations.
    expect(tierForAction("acknowledge:incident:ri-123")).toBe("review");
    expect(tierForAction("start-job:service:vast-tunnel")).toBe("review");
    expect(tierForAction("start-job:gateway:route-healthiest")).toBe("review");
    expect(tierForAction("mutate-policy:budget:global:set-cap")).toBe("review");
    expect(tierForAction("mutate-policy:gateway-keys:rotate")).toBe("review");
    // And none of them slipped into the static allowlist.
    expect(SAFE_AUTO_ACTIONS.size).toBe(2);
  });
});

describe("SPEC 10: rollback-evidence affordances", () => {
  test("every auto-tier action has a declared affordance", () => {
    for (const actionId of SAFE_AUTO_ACTIONS) {
      expect(rollbackAffordanceForAction(actionId)).not.toBeNull();
    }
    expect(rollbackAffordanceForAction("mutate-policy:model:editorial-heavy:cooldown-clear")?.kind).toBe("rollback");
    expect(rollbackAffordanceForAction("reasoner-remediate:pass-timeout:wf-1:pass-1")?.kind).toBe("rollback");
    // model-health is the explicit read-only case (rollback vacuous by design).
    expect(rollbackAffordanceForAction("start-job:model-health:all")?.kind).toBe("read-only");
    // Family ids normalize onto the map keys.
    expect(AUTO_ROLLBACK_AFFORDANCES[COOLDOWN_CLEAR_POLICY_KEY]).toBeTruthy();
    expect(AUTO_ROLLBACK_AFFORDANCES[PASS_TIMEOUT_RETRY_POLICY_KEY]).toBeTruthy();
  });

  test("review/refused actions have no affordance entry", () => {
    expect(rollbackAffordanceForAction("start-job:doctor:scan")).toBeNull();
    expect(rollbackAffordanceForAction("start-job:service:mimule-overseer")).toBeNull();
    expect(rollbackAffordanceForAction("acknowledge:incident:ri-123")).toBeNull();
    expect(rollbackAffordanceForAction(null)).toBeNull();
  });

  test("an auto-tier action without a rollback affordance is skipped and audited, not executed", async () => {
    // Simulate an operator force-promoting an action that has no declared
    // rollback affordance. The structural gate must refuse to run it.
    savePolicy({ tiers: { "start-job:timer:morning-brief": "auto" } });
    const insight = safeInsight("insight-no-rollback", "ops:no-rollback", "start-job:timer:morning-brief");
    seedAiAnalysis(insight, 0.9);

    const applied = await autoApplySafeInsights([insight]);

    expect(applied).toBe(0);
    expect(getInsight("insight-no-rollback")?.status).toBe("open");
    const rows = getDashboardDb()!.query(`
      SELECT result, result_status FROM action_audit
      WHERE action_kind = 'insights.auto-apply' AND target_id = 'insight-no-rollback'
    `).all() as Array<{ result: string; result_status: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].result).toBe(SKIPPED_NO_ROLLBACK_REASON);
    expect(rows[0].result_status).toBe("skipped");

    // Deduped: a second scheduler tick inside the window adds no new audit row.
    await autoApplySafeInsights([insight]);
    const again = getDashboardDb()!.query(`
      SELECT COUNT(*) AS n FROM action_audit
      WHERE action_kind = 'insights.auto-apply' AND target_id = 'insight-no-rollback'
    `).get() as { n: number };
    expect(again.n).toBe(1);

    // Preview tells the same story instead of promising an apply.
    const preview = previewAutoApplyCandidates([insight]);
    expect(preview[0].tier).toBe("auto");
    expect(preview[0].wouldApply).toBe(false);
    expect(preview[0].reason).toContain(SKIPPED_NO_ROLLBACK_REASON);
  });
});

describe("SPEC 10: promoted pass-timeout family auto-applies hermetically", () => {
  function seedPassTimeoutPlaybook(actionsJson = '["notify-operator"]') {
    // The real built-in pass-timeout playbook maps to retry-continuation, which
    // spawns a live builder run — not hermetic. We seed the SAME playbook id
    // with the audit-only notify-operator action so the test proves the full
    // dispatch path (tier -> rollback gate -> reasoner playbook route -> audit
    // -> insight applied) without launching an agent. The routing is identical:
    // runAutoApply -> reasonerApplyPlaybookHandler("pass-timeout", ...).
    getDashboardDb()!.query(`
      INSERT INTO reasoner_playbooks
        (id, name, description, failure_class_pattern, actions_json, is_safe, created_at)
      VALUES ('pass-timeout', 'Retry with continuation context', 'test seed', 'pass-timeout', ?, 1, ?)
    `).run(actionsJson, 1_700_000_000_000);
  }

  test("an open insight with a promoted-family action auto-applies where it previously wouldn't", async () => {
    seedPassTimeoutPlaybook();
    const insight = safeInsight(
      "insight-pass-timeout",
      "build:pass-timeout:wf-hermetic",
      "reasoner-remediate:pass-timeout:wf-hermetic:pass-1",
    );
    seedAiAnalysis(insight, 0.88);

    const applied = await autoApplySafeInsights([insight]);

    expect(applied).toBe(1);
    expect(getInsight("insight-pass-timeout")?.status).toBe("applied");

    // The audit row carries the rollback evidence: the playbook results (run
    // ids in production) and the declared rollback path.
    const row = getDashboardDb()!.query(`
      SELECT result_status, result_json, rollback_hint FROM action_audit
      WHERE action_kind = 'insights.auto-apply' AND target_id = 'insight-pass-timeout'
    `).get() as { result_status: string; result_json: string; rollback_hint: string | null };
    expect(row.result_status).toBe("success");
    const resultJson = JSON.parse(row.result_json) as {
      actionResult: { results: string[] };
      rollbackAffordance: { kind: string };
    };
    expect(Array.isArray(resultJson.actionResult.results)).toBe(true);
    expect(resultJson.actionResult.results.length).toBeGreaterThan(0);
    expect(resultJson.rollbackAffordance.kind).toBe("rollback");
    expect(row.rollback_hint ?? "").toContain("/api/builder/runs/");

    // The playbook run ledger recorded the application too.
    const rpr = getDashboardDb()!.query(`
      SELECT COUNT(*) AS n FROM reasoner_playbook_runs WHERE playbook_id = 'pass-timeout'
    `).get() as { n: number };
    expect(rpr.n).toBe(1);
  });

  test("a failing playbook dispatch is audited as failed and feeds the circuit breaker", async () => {
    // No playbook seeded: the reasoner apply handler 404s. The auto-apply must
    // record a failed audit row (breaker food) and leave the insight open.
    const insight = safeInsight(
      "insight-pass-timeout-fail",
      "build:pass-timeout:wf-missing",
      "reasoner-remediate:pass-timeout:wf-missing:pass-1",
    );
    seedAiAnalysis(insight, 0.88);

    const applied = await autoApplySafeInsights([insight]);

    expect(applied).toBe(0);
    expect(getInsight("insight-pass-timeout-fail")?.status).toBe("open");
    const row = getDashboardDb()!.query(`
      SELECT result_status FROM action_audit
      WHERE action_kind = 'insights.auto-apply' AND target_id = 'insight-pass-timeout-fail'
    `).get() as { result_status: string };
    expect(row.result_status).toBe("failed");
  });

  test("non-promoted playbook families are not auto-apply candidates", async () => {
    const insight = safeInsight(
      "insight-agent-stalled",
      "build:agent-stalled:wf-1",
      "reasoner-remediate:agent-stalled:wf-1:pass-1",
    );
    seedAiAnalysis(insight, 0.95);

    const applied = await autoApplySafeInsights([insight]);

    expect(applied).toBe(0);
    expect(getInsight("insight-agent-stalled")?.status).toBe("open");
    const count = getDashboardDb()!.query(`
      SELECT COUNT(*) AS n FROM action_audit
      WHERE action_kind = 'insights.auto-apply' AND target_id = 'insight-agent-stalled'
    `).get() as { n: number };
    expect(count.n).toBe(0);
  });
});
