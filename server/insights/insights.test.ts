import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readActionAudit } from "../db/writer.ts";
import { handleApi } from "../api/router.ts";
import { issueOperatorSessionCookie } from "../auth/session.ts";
import { aggregateInsights } from "./aggregate.ts";
import { runSecurityScan } from "./scanners/security.ts";
import { getInsight, listInsights, upsertInsight, resolveStaleInsights } from "./store.ts";
import { clearGatewayRouteOverrideForGatewayAdmin } from "../gateway/router.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevToken: string | undefined;
let prevCooldownPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "insights-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevToken = process.env.OPERATOR_TOKEN;
  prevCooldownPath = process.env.DASHBOARD_MODEL_COOLDOWNS_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.DASHBOARD_MODEL_COOLDOWNS_PATH = join(tempDir, "model-cooldowns.json");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  clearGatewayRouteOverrideForGatewayAdmin();
});

afterEach(() => {
  clearGatewayRouteOverrideForGatewayAdmin();
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  if (prevToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = prevToken;
  if (prevCooldownPath === undefined) delete process.env.DASHBOARD_MODEL_COOLDOWNS_PATH;
  else process.env.DASHBOARD_MODEL_COOLDOWNS_PATH = prevCooldownPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function db() {
  return getDashboardDb()!;
}

function apiReq(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  headers.set("x-tenant-id", "mimule");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

describe("insight aggregation", () => {
  test("normalizes cost, build, and data sources into insight rows", () => {
    const now = Date.now();
    db().query(`
      INSERT INTO spend_anomalies
        (id, tenant_id, ts, scope_type, scope_id, baseline_cents, observed_cents, multiplier, status)
      VALUES ('anom-1', 'mimule', ?, 'builder-run', 'run-1', 100, 310, 3.1, 'open')
    `).run(now);
    db().query(`
      INSERT INTO provider_price_catalog
        (id, tenant_id, provider, logical_model, tier, input_cents_per_1k, output_cents_per_1k, effective_from)
      VALUES
        ('price-paid', 'mimule', 'paid', 'paid-model', 'cloud-paid', 3, 9, ?),
        ('price-free', 'mimule', 'free', 'free-model', 'cloud-free', 0.1, 0.2, ?)
    `).run(now, now);
    db().query(`
      INSERT INTO reasoner_diagnoses
        (id, pass_id, run_id, workflow_id, failure_class, root_cause, evidence_json, suggested_actions_json, confidence, diagnosed_at, tenant_id)
      VALUES ('diag-1', 'pass-1', 'run-1', 'wf-1', 'validation_failed', 'The build command failed after the latest pass', '[]', '[{"title":"Run doctor scan"}]', 'high', ?, 'mimule')
    `).run(now);
    db().query(`
      INSERT INTO content_health_findings
        (ts, slug, finding, severity, payload_json, tenant_id)
      VALUES (?, 'story-1', 'The article is missing source coverage', 'warning', '{}', 'mimule')
    `).run(now);

    const result = aggregateInsights();
    const rows = listInsights("open");

    expect(result.createdOrUpdated).toBeGreaterThanOrEqual(4);
    expect(rows.map((row) => row.domain)).toContain("cost");
    expect(rows.map((row) => row.domain)).toContain("build");
    expect(rows.map((row) => row.domain)).toContain("data");
    expect(rows.every((row) => row.plainSummary.length > 20)).toBe(true);
  });
});

describe("security scanner", () => {
  test("flags weak secrets, broad owners, log-only policies, and uncapped active agents", () => {
    const now = Date.now();
    db().query(`
      INSERT INTO governance_secrets
        (id, name, encrypted_value, encrypted_dek, iv, key_id, created_at, updated_at, tenant_id)
      VALUES ('secret-1', 'demo-api-key', '', '', '', 'plaintext', ?, ?, 'mimule')
    `).run(now, now);
    for (const user of ["owner-a", "owner-b", "owner-c"]) {
      db().query(`
        INSERT INTO governance_role_bindings (id, user_id, role, created_at, tenant_id)
        VALUES (?, ?, 'owner', ?, 'mimule')
      `).run(`rb-${user}`, user, now);
    }
    db().query(`
      INSERT INTO governance_policy_decisions
        (policy_id, event_type, effect, rule_name, reason, context_json, decided_at, tenant_id)
      VALUES ('policy-1', 'deploy', 'log-only', 'demo', 'observe only', '{}', ?, 'mimule')
    `).run(now);
    db().query(`
      INSERT INTO builder_workflows
        (id, project_id, name, mode, status, plan_file, config_json, created_at, updated_at, tenant_id)
      VALUES ('wf-active', 'project-1', 'Active workflow', 'permanent', 'active', 'plan.md', '{}', ?, ?, 'mimule')
    `).run(now, now);

    const result = runSecurityScan();
    const titles = result.findings.map((finding) => finding.title);

    expect(titles).toContain("A secret is not fully protected");
    expect(titles).toContain("Owner access is broader than expected");
    expect(titles).toContain("Some policies are only logging decisions");
    expect(titles).toContain("Active agents do not have a budget cap");
  });
});

describe("insights API actions", () => {
  test("apply runs the action, writes audit, and marks the insight applied", async () => {
    upsertInsight({
      id: "insight-test-apply",
      domain: "cost",
      severity: "medium",
      title: "Route to cheaper model",
      plainSummary: "A cheaper healthy route is available.",
      confidence: 0.8,
      evidenceRefs: [{ label: "Gateway", kind: "api", ref: "/api/gateway/status" }],
      actionDescriptorId: "start-job:gateway:route-healthiest",
      manualPageHref: "/gateway",
      createdAt: Date.now(),
    });

    const req = apiReq("/api/insights/insight-test-apply/apply", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({ confirmed: true, reason: "prefer lower cost route" }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);

    expect(getInsight("insight-test-apply")?.status).toBe("applied");
    const audit = readActionAudit({ targetType: "insight" });
    expect(audit.some((row) => row.actionKind === "insights.apply" && row.targetId === "insight-test-apply" && row.resultStatus === "success")).toBe(true);
  });

  test("applied reversible findings expose a rollback action that can execute", async () => {
    upsertInsight({
      id: "insight-test-reversible",
      domain: "cost",
      severity: "medium",
      title: "Route to healthier model",
      plainSummary: "A healthier route is available.",
      confidence: 0.8,
      evidenceRefs: [],
      actionDescriptorId: "start-job:gateway:route-healthiest",
      manualPageHref: "/gateway",
      createdAt: Date.now(),
    });

    const applyReq = apiReq("/api/insights/insight-test-reversible/apply", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({ confirmed: true, reason: "test reversible apply" }),
    });
    const applyRes = await handleApi(applyReq, new URL(applyReq.url));
    expect(applyRes.status).toBe(200);

    const listReq = apiReq("/api/insights?status=applied", {
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
    });
    const listRes = await handleApi(listReq, new URL(listReq.url));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { data: { insights: Array<{ id: string; rollbackHint: string | null }> } };
    const applied = listBody.data.insights.find((insight) => insight.id === "insight-test-reversible");
    expect(applied?.rollbackHint).toBe("start-job:gateway:clear-route-override");

    const revertReq = apiReq("/api/actions/execute", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({
        actionId: applied?.rollbackHint,
        confirmed: true,
        reason: "test revert",
        params: {},
      }),
    });
    const revertRes = await handleApi(revertReq, new URL(revertReq.url));
    expect(revertRes.status).toBe(200);
    const audit = readActionAudit({ actionKind: "start-job.gateway" });
    expect(audit.some((row) => row.actionId === "start-job:gateway:clear-route-override" && row.resultStatus === "success")).toBe(true);
  });

  test("applied irreversible findings do not expose rollback", async () => {
    upsertInsight({
      id: "insight-test-irreversible",
      domain: "data",
      severity: "low",
      title: "Manual data review",
      plainSummary: "A manual data review was completed.",
      confidence: 0.8,
      evidenceRefs: [],
      actionDescriptorId: null,
      manualPageHref: "/insights",
      status: "applied",
      createdAt: Date.now(),
    });
    const listReq = apiReq("/api/insights?status=applied", {
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
    });
    const listRes = await handleApi(listReq, new URL(listReq.url));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { data: { insights: Array<{ id: string; rollbackHint: string | null }> } };
    const applied = listBody.data.insights.find((insight) => insight.id === "insight-test-irreversible");
    expect(applied?.rollbackHint).toBeNull();
  });

  test("dismiss requires a reason, writes audit, and marks dismissed", async () => {
    upsertInsight({
      id: "insight-test-dismiss",
      domain: "security",
      severity: "low",
      title: "Review setting",
      plainSummary: "This setting should be reviewed later.",
      confidence: 0.7,
      evidenceRefs: [],
      actionDescriptorId: null,
      manualPageHref: "/governance",
      createdAt: Date.now(),
    });

    const req = apiReq("/api/insights/insight-test-dismiss/dismiss", {
      method: "POST",
      headers: { "x-operator-token": "test-token" },
      body: JSON.stringify({ reason: "accepted for the demo" }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);

    expect(getInsight("insight-test-dismiss")?.status).toBe("dismissed");
    const audit = readActionAudit({ targetType: "insight" });
    expect(audit.some((row) => row.actionKind === "insights.dismiss" && row.reason === "accepted for the demo")).toBe(true);
  });

  test("bulk acknowledge records acknowledgement metadata and audit", async () => {
    for (const id of ["insight-test-ack-1", "insight-test-ack-2"]) {
      upsertInsight({
        id,
        domain: "ops",
        severity: "low",
        title: `Acknowledge ${id}`,
        plainSummary: "Operator should acknowledge this finding.",
        confidence: 0.7,
        evidenceRefs: [],
        actionDescriptorId: null,
        manualPageHref: "/insights",
        createdAt: Date.now(),
      });
    }

    const req = apiReq("/api/insights/bulk-ack", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({ ids: ["insight-test-ack-1", "insight-test-ack-2"], reason: "triaged together" }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { acknowledged: number; acknowledgedIds: string[] } };
    expect(body.data.acknowledged).toBe(2);
    expect(getInsight("insight-test-ack-1")?.acknowledgedAt).toBeTruthy();
    const audit = readActionAudit({ actionKind: "insights.bulk-ack" });
    expect(audit.some((row) => row.resultStatus === "success" && row.reason === "triaged together")).toBe(true);
  });

  test("bulk snooze hides open findings until expiry and writes audit", async () => {
    upsertInsight({
      id: "insight-test-snooze",
      domain: "ops",
      severity: "medium",
      title: "Snooze me",
      plainSummary: "This finding can wait.",
      confidence: 0.7,
      evidenceRefs: [],
      actionDescriptorId: null,
      manualPageHref: "/insights",
      createdAt: Date.now(),
    });

    const req = apiReq("/api/insights/bulk-snooze", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({ ids: ["insight-test-snooze"], until: Date.now() + 60_000, reason: "quiet window" }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(listInsights("open").some((insight) => insight.id === "insight-test-snooze")).toBe(false);
    expect(getInsight("insight-test-snooze")?.snoozedUntil).toBeTruthy();
    const audit = readActionAudit({ actionKind: "insights.bulk-snooze" });
    expect(audit.some((row) => row.resultStatus === "success" && row.reason === "quiet window")).toBe(true);
  });

  test("bulk apply-safe applies auto-tier findings and skips review-tier findings", async () => {
    upsertInsight({
      id: "insight-test-bulk-auto",
      domain: "ops",
      severity: "low",
      title: "Clear cooldown",
      plainSummary: "A model cooldown expired.",
      confidence: 0.9,
      evidenceRefs: [],
      actionDescriptorId: "mutate-policy:model:test-model:cooldown-clear",
      manualPageHref: "/models",
      createdAt: Date.now(),
    });
    upsertInsight({
      id: "insight-test-bulk-review",
      domain: "security",
      severity: "high",
      title: "Set budget",
      plainSummary: "A budget cap needs review.",
      confidence: 0.9,
      evidenceRefs: [],
      actionDescriptorId: "mutate-policy:budget:global:set-cap",
      manualPageHref: "/governance",
      createdAt: Date.now(),
    });

    const req = apiReq("/api/insights/bulk-apply", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({
        ids: ["insight-test-bulk-auto", "insight-test-bulk-review"],
        reason: "apply only safe",
        confirmed: true,
        mode: "autoOnly",
      }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { applied: number; skipped: Array<{ id: string; reason: string }> } };
    expect(body.data.applied).toBe(1);
    expect(body.data.skipped.some((row) => row.id === "insight-test-bulk-review" && row.reason.includes("review-tier"))).toBe(true);
    expect(getInsight("insight-test-bulk-auto")?.status).toBe("applied");
    expect(getInsight("insight-test-bulk-review")?.status).toBe("open");
  });

  test("bulk mutation without an operator token fails closed", async () => {
    upsertInsight({
      id: "insight-test-no-token",
      domain: "ops",
      severity: "low",
      title: "No token",
      plainSummary: "Mutation should fail closed.",
      confidence: 0.7,
      evidenceRefs: [],
      actionDescriptorId: null,
      manualPageHref: "/insights",
      createdAt: Date.now(),
    });
    delete process.env.OPERATOR_TOKEN;
    const req = apiReq("/api/insights/bulk-ack", {
      method: "POST",
      body: JSON.stringify({ ids: ["insight-test-no-token"] }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(401);
    process.env.OPERATOR_TOKEN = "test-token";
  });

  test("auditor can view insights but cannot apply them", async () => {
    const now = Date.now();
    db().query(`
      INSERT INTO users (id, email, name, auth_method, created_at, tenant_id)
      VALUES ('auditor-user', 'auditor@example.test', 'Auditor User', 'local', ?, 'mimule')
    `).run(now);
    db().query(`
      INSERT INTO governance_role_bindings (id, user_id, role, created_at, tenant_id)
      VALUES ('rb-auditor', 'auditor-user', 'auditor', ?, 'mimule')
    `).run(now);
    upsertInsight({
      id: "insight-test-rbac",
      domain: "cost",
      severity: "medium",
      title: "Route to cheaper model",
      plainSummary: "A cheaper healthy route is available.",
      confidence: 0.8,
      evidenceRefs: [],
      actionDescriptorId: "start-job:gateway:route-healthiest",
      manualPageHref: "/gateway",
      createdAt: now,
    });

    const viewReq = apiReq("/api/insights", {
      headers: { cookie: issueOperatorSessionCookie("auditor-user", "mimule") },
    });
    const viewRes = await handleApi(viewReq, new URL(viewReq.url));
    expect(viewRes.status).toBe(200);

    const applyReq = apiReq("/api/insights/insight-test-rbac/apply", {
      method: "POST",
      headers: { cookie: issueOperatorSessionCookie("auditor-user", "mimule") },
      body: JSON.stringify({ confirmed: true, reason: "test apply" }),
    });
    const applyRes = await handleApi(applyReq, new URL(applyReq.url));
    expect(applyRes.status).toBe(403);
    expect(getInsight("insight-test-rbac")?.status).toBe("open");
  });

  test("rejects spoofed insight apply when no operator session is present", async () => {
    const now = Date.now();
    db().query(`
      INSERT INTO governance_role_bindings (id, user_id, role, created_at, tenant_id)
      VALUES ('rb-owner-spoof', 'owner-user', 'owner', ?, 'mimule')
    `).run(now);
    upsertInsight({
      id: "insight-test-spoof",
      domain: "cost",
      severity: "medium",
      title: "Route to cheaper model",
      plainSummary: "A cheaper healthy route is available.",
      confidence: 0.8,
      evidenceRefs: [],
      actionDescriptorId: "start-job:gateway:route-healthiest",
      manualPageHref: "/gateway",
      createdAt: now,
    });

    const applyReq = apiReq("/api/insights/insight-test-spoof/apply", {
      method: "POST",
      headers: { "x-user-id": "owner-user" },
      body: JSON.stringify({ confirmed: true, reason: "spoof owner identity" }),
    });
    const applyRes = await handleApi(applyReq, new URL(applyReq.url));

    expect(applyRes.status).toBe(401);
    expect(getInsight("insight-test-spoof")?.status).toBe("open");
    const audit = readActionAudit({ targetType: "insight" });
    expect(audit.some((row) => row.targetId === "insight-test-spoof")).toBe(false);
  });

  test("executeActionHandler: mutate-policy:budget:global:set-cap with valid params succeeds", async () => {
    const req = apiReq("/api/actions/execute", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({
        actionId: "mutate-policy:budget:global:set-cap",
        confirmed: true,
        reason: "set budget cap for demo",
        params: { dailyCapUsd: 10, monthlyCapUsd: 100 },
      }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; result?: { budget: { daily_cap_usd: number; monthly_cap_usd: number; warn_pct: number } } };
    expect(body.ok).toBe(true);
    expect(body.result?.budget).toBeDefined();
    expect(body.result!.budget.daily_cap_usd).toBe(10);
    expect(body.result!.budget.monthly_cap_usd).toBe(100);
    expect(body.result!.budget.warn_pct).toBe(0.8);

    const audit = readActionAudit({ targetType: "budget" });
    expect(audit.some((row) => row.actionKind === "mutate-policy.budget" && row.resultStatus === "success")).toBe(true);
  });

  test("executeActionHandler: mutate-policy:budget:global:set-cap with invalid dailyCapUsd fails", async () => {
    const req = apiReq("/api/actions/execute", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({
        actionId: "mutate-policy:budget:global:set-cap",
        confirmed: true,
        reason: "test invalid",
        params: { dailyCapUsd: -5, monthlyCapUsd: 100 },
      }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("dailyCapUsd must be a number between 1 and 10000");

    const budgets = db().query("SELECT * FROM governance_budgets WHERE scope = 'global'").all();
    expect(budgets.length).toBe(0);
  });

  test("resolveStaleInsights: resolves stale insights and persists status, resolvedAt, resolution in DB", () => {
    const now = Date.now();
    const sourceKeyPrefix = "scanner:security";

    upsertInsight({
      id: "insight-stale-1",
      domain: "security",
      severity: "high",
      title: "Stale finding 1",
      plainSummary: "This finding is no longer active",
      confidence: 0.9,
      evidenceRefs: [],
      actionDescriptorId: null,
      manualPageHref: "/governance",
      createdAt: now - 10000,
      sourceKey: "scanner:security:finding-1",
    });

    upsertInsight({
      id: "insight-stale-2",
      domain: "security",
      severity: "medium",
      title: "Stale finding 2",
      plainSummary: "This finding is also stale",
      confidence: 0.8,
      evidenceRefs: [],
      actionDescriptorId: null,
      manualPageHref: "/governance",
      createdAt: now - 5000,
      sourceKey: "scanner:security:finding-2",
    });

    upsertInsight({
      id: "insight-active",
      domain: "security",
      severity: "low",
      title: "Active finding",
      plainSummary: "This finding is still active",
      confidence: 0.7,
      evidenceRefs: [],
      actionDescriptorId: null,
      manualPageHref: "/governance",
      createdAt: now,
      sourceKey: "scanner:security:finding-3",
    });

    const activeSourceKeys = ["scanner:security:finding-3"];
    const resolution = "Automatically resolved: source no longer reported";

    const resolved = resolveStaleInsights(sourceKeyPrefix, activeSourceKeys, resolution);

    expect(resolved.length).toBe(2);
    expect(resolved.map((r) => r.id).sort()).toEqual(["insight-stale-1", "insight-stale-2"]);

    const reloaded1 = getInsight("insight-stale-1");
    const reloaded2 = getInsight("insight-stale-2");
    const stillActive = getInsight("insight-active");

    expect(reloaded1).not.toBeNull();
    expect(reloaded1!.status).toBe("resolved");
    expect(typeof reloaded1!.resolvedAt).toBe("number");
    expect(reloaded1!.resolvedAt!).toBeGreaterThan(0);
    expect(reloaded1!.resolution).toBe(resolution);

    expect(reloaded2).not.toBeNull();
    expect(reloaded2!.status).toBe("resolved");
    expect(typeof reloaded2!.resolvedAt).toBe("number");
    expect(reloaded2!.resolvedAt!).toBeGreaterThan(0);
    expect(reloaded2!.resolution).toBe(resolution);

    expect(stillActive).not.toBeNull();
    expect(stillActive!.status).toBe("open");
    expect(stillActive!.resolvedAt).toBeNull();
    expect(stillActive!.resolution).toBeNull();
  });

  test("security scanner: active agents without budget cap finding has actionDescriptorId", () => {
    const now = Date.now();
    db().query(`
      INSERT INTO builder_workflows
        (id, project_id, name, mode, status, plan_file, config_json, created_at, updated_at, tenant_id)
      VALUES ('wf-active-2', 'project-1', 'Active workflow 2', 'permanent', 'active', 'plan.md', '{}', ?, ?, 'mimule')
    `).run(now, now);

    const result = runSecurityScan();
    const finding = result.findings.find((f) => f.id === "insight_security_agents_without_budget_cap");
    expect(finding).toBeDefined();
    expect(finding?.actionDescriptorId).toBe("mutate-policy:budget:global:set-cap");
  });

  test("end-to-end: insightApplyHandler applies budget cap insight", async () => {
    upsertInsight({
      id: "insight-test-budget-cap",
      domain: "security",
      severity: "high",
      title: "Active agents do not have a budget cap",
      plainSummary: "At least one agent workflow is active, but no daily or monthly budget cap is configured.",
      confidence: 0.88,
      evidenceRefs: [],
      actionDescriptorId: "mutate-policy:budget:global:set-cap",
      manualPageHref: "/governance",
      createdAt: Date.now(),
    });

    const req = apiReq("/api/insights/insight-test-budget-cap/apply", {
      method: "POST",
      headers: { "x-operator-token": "test-token", "x-user-id": "owner-user" },
      body: JSON.stringify({ confirmed: true, reason: "test apply budget cap" }),
    });
    const res = await handleApi(req, new URL(req.url));
    expect(res.status).toBe(200);

    expect(getInsight("insight-test-budget-cap")?.status).toBe("applied");

    const budgets = db().query("SELECT * FROM governance_budgets WHERE scope = 'global'").all() as Array<{ daily_cap_usd: number; monthly_cap_usd: number }>;
    expect(budgets.length).toBe(1);
    expect(budgets[0].daily_cap_usd).toBe(5);
    expect(budgets[0].monthly_cap_usd).toBe(50);
  });
});
