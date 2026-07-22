import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { issueOperatorSessionCookie } from "../auth/session.ts";
import { handleApi } from "../api/router.ts";
import { _resetGatewayConfigCacheForTests } from "../gateway/config.ts";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  createAiProviderVendorGroup,
  configuredProviderKeys,
  deleteAiProviderVendorGroup,
  deleteAiProviderVendorGroupRule,
  getAiProviderProfile,
  listAiProviderRegister,
  listAiProviderProfiles,
  PROVIDER_ZERO_SUCCESS_WINDOW_MS,
  saveAiProviderDeclaration,
  saveAiProviderVendorGroupRule,
  updateAiProviderVendorGroup,
  validateProviderDeclaration,
} from "./aiProviders.ts";

const NOW = 1_700_000_000_000;
let tempDir: string;
let previousDb: string | undefined;
let previousDbPath: string | undefined;
let previousToken: string | undefined;
let previousSessionSecret: string | undefined;
let previousGatewayConfig: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "ai-providers-test-"));
  previousDb = process.env.DASHBOARD_DB;
  previousDbPath = process.env.DASHBOARD_DB_PATH;
  previousToken = process.env.OPERATOR_TOKEN;
  previousSessionSecret = process.env.OPERATOR_SESSION_SECRET;
  previousGatewayConfig = process.env.GATEWAY_CONFIG;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.OPERATOR_SESSION_SECRET = "ai-providers-test-secret";
  process.env.GATEWAY_CONFIG = join(tempDir, "gateway.yaml");
  writeFileSync(process.env.GATEWAY_CONFIG, `version: 1\nmodels:\n  primary:\n    model: bespoke/model-a\n    tier: local\n    fallback_chain: [shadow-route]\n`);
  _resetGatewayConfigCacheForTests();
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (previousDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDb;
  if (previousDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDbPath;
  if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousToken;
  if (previousSessionSecret === undefined) delete process.env.OPERATOR_SESSION_SECRET;
  else process.env.OPERATOR_SESSION_SECRET = previousSessionSecret;
  if (previousGatewayConfig === undefined) delete process.env.GATEWAY_CONFIG;
  else process.env.GATEWAY_CONFIG = previousGatewayConfig;
  _resetGatewayConfigCacheForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

function db() {
  return getDashboardDb()!;
}

function tenant(tenantId: string) {
  return testTenantContext({ tenantId });
}

function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataClasses: ["editorial prompts"],
    credentialLocation: "process.env.BESPOKE_API_KEY",
    egressBoundary: "external-provider",
    owner: "operator@example.test",
    riskLikelihood: 3,
    riskImpact: 4,
    treatment: "mitigate",
    lastReviewedAt: NOW,
    ...overrides,
  };
}

function vendorGroup(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, declaration: declaration(overrides) };
}

function insertGatewayCall(tenantId: string, resolvedModel: string, ts: number, success: number): void {
  db().query(`
    INSERT INTO gateway_calls
      (ts, logical_model, resolved_model, backend, tier, success, tenant_id)
    VALUES (?, 'logical', ?, 'litellm', 'cloud-free', ?, ?)
  `).run(ts, resolvedModel, success, tenantId);
}

function insertBuilderPass(tenantId: string, provider: string, status: "success" | "failed" = "success"): void {
  const id = `${tenantId}-${provider}-${Math.random().toString(36).slice(2)}`;
  db().query(`
    INSERT INTO builder_passes
      (id, run_id, workflow_id, sequence, phase, status, provider, model, started_at, finished_at, tenant_id)
    VALUES (?, ?, ?, 1, 'implement', ?, ?, 'model-a', ?, ?, ?)
  `).run(id, `run-${id}`, `workflow-${id}`, status, provider, NOW - 500, NOW, tenantId);
}

function insertRouteTruth(tenantId: string, sourceKey: string): void {
  db().query(`
    INSERT INTO insights
      (id, domain, severity, title, plain_summary, confidence, evidence_refs_json, manual_page_href, status, tenant_id, created_at, source_key)
    VALUES (?, 'models', 'high', 'route truth', 'route truth', 0.9, '[]', '/models', 'open', ?, ?, ?)
  `).run(`insight-${sourceKey}-${tenantId}`, tenantId, NOW, sourceKey);
}

function seedUser(userId: string, role: "viewer" | "operator", tenantId = "mimule"): void {
  db().query(`INSERT INTO users (id, email, name, auth_method, created_at, tenant_id) VALUES (?, ?, ?, 'local', ?, ?)`)
    .run(userId, `${userId}@example.test`, userId, NOW, tenantId);
  db().query(`INSERT INTO governance_role_bindings (id, user_id, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(`binding-${userId}`, userId, role, tenantId, NOW);
}

function sessionRequest(userId: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-tenant-id": "mimule",
      cookie: issueOperatorSessionCookie(userId, "mimule"),
      ...(init.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

describe("AI provider register", () => {
  test("enumerates only configuration and real telemetry identifiers, never a marketing list", () => {
    expect(configuredProviderKeys()).toEqual(["bespoke", "shadow-route"]);
    insertGatewayCall("t-alpha", "observed-provider/model-z", NOW, 1);
    insertBuilderPass("t-alpha", "builder-source");

    const providers = listAiProviderProfiles(tenant("t-alpha"), NOW);
    expect(providers.map((provider) => provider.key)).toEqual(["bespoke", "builder-source", "observed-provider", "shadow-route"]);
    expect(providers.every((provider) => provider.declaration.state === "undeclared")).toBe(true);
    expect(providers.find((provider) => provider.key === "observed-provider")?.evidence.gatewayIdentifiers).toEqual(["observed-provider/model-z"]);
    expect(providers.find((provider) => provider.key === "builder-source")?.evidence.builderIdentifiers).toEqual(["builder-source"]);
  });

  test("keeps declarations tenant-local, honest, and confined to provider profile rows", () => {
    const auditBefore = Number((db().query("SELECT COUNT(*) AS count FROM action_audit").get() as { count: number }).count);
    const partial = saveAiProviderDeclaration("bespoke", declaration({ credentialLocation: null, lastReviewedAt: null }), "operator", tenant("t-alpha"), NOW);
    expect(partial).toMatchObject({ ok: true });
    if (partial.ok) expect(partial.provider.declaration.state).toBe("unreviewed");

    const complete = saveAiProviderDeclaration("bespoke", declaration(), "operator", tenant("t-alpha"), NOW);
    expect(complete).toMatchObject({ ok: true });
    if (complete.ok) {
      expect(complete.provider.declaration).toMatchObject({ state: "reviewed", updatedBy: "operator" });
      expect(complete.provider.riskScore).toBe(12);
    }
    expect(getAiProviderProfile("bespoke", tenant("t-beta"), NOW)?.declaration.state).toBe("undeclared");
    expect(Number((db().query("SELECT COUNT(*) AS count FROM ai_provider_risk_profiles").get() as { count: number }).count)).toBe(1);
    expect(Number((db().query("SELECT COUNT(*) AS count FROM action_audit").get() as { count: number }).count)).toBe(auditBefore);
  });

  test("rejects invalid risk, incomplete review, and credential-value-like declarations", () => {
    expect(validateProviderDeclaration(declaration({ riskLikelihood: 6 }), NOW)).toMatchObject({ ok: false });
    expect(validateProviderDeclaration(declaration({ riskImpact: null }), NOW)).toMatchObject({ ok: false });
    expect(validateProviderDeclaration(declaration({ credentialLocation: "sk-secret-value" }), NOW)).toMatchObject({ ok: false });
    expect(validateProviderDeclaration(declaration({ credentialLocation: "TOKEN=value" }), NOW)).toMatchObject({ ok: false });
    expect(validateProviderDeclaration(declaration({ credentialLocation: "plain-text" }), NOW)).toMatchObject({ ok: false });
    expect(validateProviderDeclaration(declaration({ dataClasses: [], lastReviewedAt: NOW }), NOW)).toMatchObject({ ok: false });
    expect(saveAiProviderDeclaration("not-observed", declaration(), "operator", tenant("t-alpha"), NOW)).toMatchObject({ ok: false, status: 404 });
  });

  test("joins only real gateway, builder, and S7 evidence and makes the 17-day zero-success condition dual-purpose", () => {
    const windowStart = NOW - PROVIDER_ZERO_SUCCESS_WINDOW_MS;
    insertGatewayCall("t-alpha", "broken-route", windowStart, 0);
    insertGatewayCall("t-alpha", "broken-route", NOW, 0);
    insertGatewayCall("t-alpha", "broken-route", NOW - 1000, 0);
    insertGatewayCall("t-alpha", "broken-route", NOW - 2000, 0);
    insertGatewayCall("t-alpha", "broken-route", NOW - 3000, 0);
    insertBuilderPass("t-alpha", "builder-source", "success");
    insertRouteTruth("t-alpha", "models:dead-route:broken-route");
    insertGatewayCall("t-beta", "broken-route", NOW, 1);
    insertRouteTruth("t-beta", "models:degraded-route:broken-route");

    const broken = getAiProviderProfile("broken-route", tenant("t-alpha"), NOW)!;
    expect(broken.declaration.state).toBe("undeclared");
    expect(broken.evidence.gateway).toMatchObject({ calls: 5, successes: 0, recentCalls: 5, recentSuccesses: 0 });
    expect(broken.evidence.zeroSuccess17d).toBe(true);
    expect(broken.evidence.routeTruthFindingKinds).toEqual(["dead-route"]);
    expect(getAiProviderProfile("broken-route", tenant("t-beta"), NOW)?.evidence.routeTruthFindingKinds).toEqual(["degraded-route"]);
  });

  test("returns configuration-derived undeclared rows safely without a dashboard database and rejects mutation", () => {
    closeDashboardDb();
    const providers = listAiProviderProfiles(tenant("t-alpha"), NOW);
    expect(providers.map((provider) => provider.key)).toEqual(["bespoke", "shadow-route"]);
    expect(providers.every((provider) => provider.evidence.available === false && provider.declaration.state === "undeclared")).toBe(true);
    expect(listAiProviderRegister(tenant("t-alpha"), NOW)).toMatchObject({
      vendorGroups: [],
      ungroupedProviders: [{ key: "bespoke" }, { key: "shadow-route" }],
    });
    expect(saveAiProviderDeclaration("bespoke", declaration(), "operator", tenant("t-alpha"), NOW)).toMatchObject({ ok: false, status: 503 });
    expect(createAiProviderVendorGroup(vendorGroup("OpenRouter"), "operator", tenant("t-alpha"), NOW)).toMatchObject({ ok: false, status: 503 });
  });

  test("groups only operator-curated key and prefix rules, aggregates evidence, and leaves every unmapped key visible", () => {
    insertGatewayCall("t-alpha", "openrouter-gemma4-31b-free/model-a", NOW - 100, 1);
    insertGatewayCall("t-alpha", "openrouter-qwen/model-b", NOW, 0);
    insertBuilderPass("t-alpha", "openrouter-gemma4-31b-free", "success");
    insertRouteTruth("t-alpha", "models:dead-route:openrouter-qwen");

    const created = createAiProviderVendorGroup(vendorGroup("OpenRouter"), "operator", tenant("t-alpha"), NOW);
    expect(created).toMatchObject({ ok: true, vendorGroup: { key: "openrouter", riskScore: 12 } });
    const keyRule = saveAiProviderVendorGroupRule("openrouter", { kind: "key", value: "openrouter-gemma4-31b-free" }, "operator", tenant("t-alpha"), NOW);
    expect(keyRule).toMatchObject({ ok: true, rule: { kind: "key", value: "openrouter-gemma4-31b-free" } });
    const prefixRule = saveAiProviderVendorGroupRule("openrouter", { kind: "prefix", value: "openrouter-" }, "operator", tenant("t-alpha"), NOW);
    expect(prefixRule).toMatchObject({ ok: true, rule: { kind: "prefix", value: "openrouter-" } });

    const register = listAiProviderRegister(tenant("t-alpha"), NOW);
    const group = register.vendorGroups[0]!;
    expect(group.name).toBe("OpenRouter");
    expect(group.rules.map((rule) => `${rule.kind}:${rule.value}`)).toEqual([
      "key:openrouter-gemma4-31b-free",
      "prefix:openrouter-",
    ]);
    expect(group.members.map((member) => member.key)).toEqual(["openrouter-gemma4-31b-free", "openrouter-qwen"]);
    expect(group.members[0]?.grouping).toMatchObject({ operatorCurated: true, rule: { kind: "key" } });
    expect(group.members[1]?.grouping).toMatchObject({ operatorCurated: true, rule: { kind: "prefix", value: "openrouter-" } });
    expect(group.evidence.gateway).toMatchObject({ calls: 2, successes: 1 });
    expect(group.evidence.builderPasses).toMatchObject({ passes: 1, successes: 1 });
    expect(group.evidence.routeTruthFindingKinds).toEqual(["dead-route"]);
    expect(register.ungroupedProviders.map((provider) => provider.key)).toEqual(["bespoke", "shadow-route"]);
    expect(register.providers.map((provider) => provider.key)).toContain("openrouter-gemma4-31b-free");
  });

  test("keeps vendor groups tenant-local, rejects inferred/overlapping routes, and never deletes per-key declarations", () => {
    insertGatewayCall("t-alpha", "openrouter-gemma/model-a", NOW, 1);
    insertGatewayCall("t-alpha", "nvidia-nim/model-a", NOW, 1);
    const routeDeclaration = saveAiProviderDeclaration("openrouter-gemma", declaration(), "operator", tenant("t-alpha"), NOW);
    expect(routeDeclaration).toMatchObject({ ok: true });

    expect(createAiProviderVendorGroup(vendorGroup("OpenRouter"), "operator", tenant("t-alpha"), NOW)).toMatchObject({ ok: true });
    expect(createAiProviderVendorGroup(vendorGroup("Unsafe vendor", { credentialLocation: "sk-should-not-store" }), "operator", tenant("t-alpha"), NOW))
      .toMatchObject({ ok: false, status: 400 });
    const prefix = saveAiProviderVendorGroupRule("openrouter", { kind: "prefix", value: "openrouter-" }, "operator", tenant("t-alpha"), NOW);
    expect(prefix).toMatchObject({ ok: true });
    expect(createAiProviderVendorGroup(vendorGroup("NVIDIA NIM"), "operator", tenant("t-alpha"), NOW)).toMatchObject({ ok: true });
    expect(saveAiProviderVendorGroupRule("nvidia-nim", { kind: "prefix", value: "openrouter" }, "operator", tenant("t-alpha"), NOW))
      .toMatchObject({ ok: false, status: 400 });
    expect(saveAiProviderVendorGroupRule("nvidia-nim", { kind: "key", value: "not-observed" }, "operator", tenant("t-alpha"), NOW))
      .toMatchObject({ ok: false, status: 400 });
    expect(saveAiProviderVendorGroupRule("nvidia-nim", { kind: "prefix", value: "nvidia-" }, "operator", tenant("t-alpha"), NOW))
      .toMatchObject({ ok: true });

    expect(listAiProviderRegister(tenant("t-beta"), NOW).vendorGroups).toEqual([]);
    expect(deleteAiProviderVendorGroup("openrouter", tenant("t-alpha"))).toMatchObject({ ok: true, groupKey: "openrouter" });
    expect(getAiProviderProfile("openrouter-gemma", tenant("t-alpha"), NOW)?.declaration).toMatchObject({ state: "reviewed", updatedBy: "operator" });
    expect(Number((db().query("SELECT COUNT(*) AS count FROM ai_provider_vendor_groups").get() as { count: number }).count)).toBe(1);
    expect(Number((db().query("SELECT COUNT(*) AS count FROM ai_provider_vendor_group_rules").get() as { count: number }).count)).toBe(1);
  });

  test("updates group declarations and removes rules without touching route declarations", () => {
    insertGatewayCall("t-alpha", "github-models/model-a", NOW, 1);
    expect(saveAiProviderDeclaration("github-models", declaration(), "operator", tenant("t-alpha"), NOW)).toMatchObject({ ok: true });
    expect(createAiProviderVendorGroup(vendorGroup("GitHub Models"), "operator", tenant("t-alpha"), NOW)).toMatchObject({ ok: true });
    const saved = saveAiProviderVendorGroupRule("github-models", { kind: "prefix", value: "github-" }, "operator", tenant("t-alpha"), NOW);
    expect(saved).toMatchObject({ ok: true });
    if (!saved.ok) throw new Error("rule save failed");
    expect(updateAiProviderVendorGroup("github-models", vendorGroup("GitHub Hosted Models", { riskImpact: 5 }), "reviewer", tenant("t-alpha"), NOW))
      .toMatchObject({ ok: true, vendorGroup: { name: "GitHub Hosted Models", riskScore: 15 } });
    expect(deleteAiProviderVendorGroupRule("github-models", saved.rule.id, tenant("t-alpha"), NOW)).toMatchObject({ ok: true });
    expect(listAiProviderRegister(tenant("t-alpha"), NOW).ungroupedProviders.map((provider) => provider.key)).toContain("github-models");
    expect(getAiProviderProfile("github-models", tenant("t-alpha"), NOW)?.declaration).toMatchObject({ state: "reviewed", updatedBy: "operator" });
  });
});

describe("AI provider register API gates", () => {
  test("rejects anonymous requests and lets viewers read but not mutate", async () => {
    const unauthenticatedGet = new Request("http://localhost/api/ai-provider-register");
    const unauthenticatedPut = new Request("http://localhost/api/ai-provider-register/bespoke", { method: "PUT" });
    expect((await handleApi(unauthenticatedGet, new URL(unauthenticatedGet.url))).status).toBe(401);
    expect((await handleApi(unauthenticatedPut, new URL(unauthenticatedPut.url))).status).toBe(401);

    seedUser("viewer", "viewer");
    expect((await handleApi(sessionRequest("viewer", "/api/ai-provider-register"), new URL("http://localhost/api/ai-provider-register"))).status).toBe(200);
    const denied = sessionRequest("viewer", "/api/ai-provider-register/bespoke", { method: "PUT", body: JSON.stringify(declaration()) });
    expect((await handleApi(denied, new URL(denied.url))).status).toBe(403);
    const viewerGroup = sessionRequest("viewer", "/api/ai-provider-register/groups", { method: "POST", body: JSON.stringify(vendorGroup("OpenRouter")) });
    expect((await handleApi(viewerGroup, new URL(viewerGroup.url))).status).toBe(403);
  });

  test("requires the mutation gate and stores only the provider declaration row", async () => {
    seedUser("operator", "operator");
    const request = sessionRequest("operator", "/api/ai-provider-register/bespoke", { method: "PUT", body: JSON.stringify(declaration()) });
    const response = await handleApi(request, new URL(request.url));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { provider: { declaration: { state: string; updatedBy: string | null } } } };
    expect(body.data.provider.declaration).toMatchObject({ state: "reviewed", updatedBy: "operator" });
    expect(Number((db().query("SELECT COUNT(*) AS count FROM ai_provider_risk_profiles").get() as { count: number }).count)).toBe(1);
  });

  test("uses the exact S11 token and mutation gates for vendor group routes", async () => {
    const anonymous = new Request("http://localhost/api/ai-provider-register/groups", { method: "POST", body: JSON.stringify(vendorGroup("OpenRouter")) });
    expect((await handleApi(anonymous, new URL(anonymous.url))).status).toBe(401);

    seedUser("operator", "operator");
    const create = sessionRequest("operator", "/api/ai-provider-register/groups", { method: "POST", body: JSON.stringify(vendorGroup("OpenRouter")) });
    expect((await handleApi(create, new URL(create.url))).status).toBe(201);
    insertGatewayCall("mimule", "openrouter-gemma/model-a", NOW, 1);
    const rule = sessionRequest("operator", "/api/ai-provider-register/groups/openrouter/rules", {
      method: "POST",
      body: JSON.stringify({ kind: "prefix", value: "openrouter-" }),
    });
    expect((await handleApi(rule, new URL(rule.url))).status).toBe(201);
    expect(Number((db().query("SELECT COUNT(*) AS count FROM ai_provider_vendor_groups").get() as { count: number }).count)).toBe(1);
    expect(Number((db().query("SELECT COUNT(*) AS count FROM ai_provider_vendor_group_rules").get() as { count: number }).count)).toBe(1);
  });
});
