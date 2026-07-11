import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { upsertBudget } from "../governance/budgets.ts";
import { _resetGatewayConfigCacheForTests, loadGatewayConfig } from "../gateway/config.ts";
import {
  clearGatewayRouteOverrideForGatewayAdmin,
  resetGatewayRouteOverrideStateForTests,
  setGatewayRouteOverrideForGatewayAdmin,
} from "../gateway/router.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { actionId, buildActionCatalog } from "./actionDescriptors.ts";

test("action ids are stable and safe for lookup", () => {
  expect(actionId("start-job", "service", "NewsBites Autopipeline", "restart now")).toBe(
    "start-job:service:newsbites-autopipeline:restart-now",
  );
});

test("catalog always emits the global budget descriptor and emits project descriptors only for stored project budgets", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "budget-descriptors-"));
  const prevDb = process.env.DASHBOARD_DB;
  const prevDbPath = process.env.DASHBOARD_DB_PATH;
  closeDashboardDb();
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  try {
    const before = tenantStore.run(testTenantContext({ tenantId: "budget-test" }), () => buildActionCatalog({}));
    const global = before.find((action) => action.id === "mutate-policy:budget:global:set-cap");
    expect(global?.risk).toBe("medium");
    expect(global?.confirm).toBe(true);
    expect(global?.reasonRequired).toBe(true);
    expect(before.some((action) => action.id.startsWith("mutate-policy:budget:project:"))).toBe(false);

    tenantStore.run(testTenantContext({ tenantId: "budget-test" }), () => {
      upsertBudget("project", {
        projectId: "project-alpha",
        dailyCapUsd: 3,
        monthlyCapUsd: 30,
        warnPct: 0.75,
      });
    });
    const after = tenantStore.run(testTenantContext({ tenantId: "budget-test" }), () => buildActionCatalog({}));
    const project = after.find((action) => action.id === "mutate-policy:budget:project:project-alpha:set-cap");
    expect(project?.risk).toBe("medium");
    expect(project?.confirm).toBe(true);
    expect(project?.reasonRequired).toBe(true);
  } finally {
    closeDashboardDb();
    if (prevDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = prevDb;
    if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = prevDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("catalog marks allowlisted and non-allowlisted service restarts", () => {
  const actions = buildActionCatalog({
    services: [
      { name: "control-surface", status: "active" },
      { name: "paperclip_db", status: "active" },
    ],
  });

  const allowed = actions.find((action) => action.kind === "start-job" && action.targetId === "control-surface");
  const denied = actions.find((action) => action.kind === "start-job" && action.targetId === "paperclip_db");

  expect(allowed?.risk).toBe("high");
  expect(allowed?.confirm).toBe(true);
  expect(allowed?.reasonRequired).toBe(true);
  expect(allowed?.disabled).toBe(false);
  expect(allowed?.jobKind).toBe("service-restart");

  expect(denied?.disabled).toBe(true);
  expect(denied?.disabledReason).toContain("allowlist");
});

test("catalog omits synthetic incident lifecycle descriptors", () => {
  const actions = buildActionCatalog({
    incidents: [
      {
        ts: Date.UTC(2026, 4, 10),
        type: "pipeline-failed",
        slug: "story-a",
        stage: "write",
        errorType: "transport_timeout",
      },
      {
        ts: Date.UTC(2026, 4, 10),
        type: "doctor-abandoned",
        slug: "story-b",
        stage: "verify",
        errorType: "quality_garbage",
      },
    ],
  });

  const incidentActions = actions.filter((action) => action.targetType === "incident");

  expect(incidentActions).toEqual([]);
});

test("catalog includes model action descriptors with audit-ready metadata", () => {
  const actions = buildActionCatalog({
    models: [
      {
        logicalName: "editorial-heavy",
        provider: "litellm",
        capability: "heavy",
        available: true,
        latency: 1200,
        jsonOk: true,
        checkedAt: Date.now(),
        qualityStatus: "healthy",
        recentFailures: 0,
        consecutiveGarbage: 0,
        isFree: false,
        isPaid: true,
        isOpenCode: false,
        isCli: true,
        providerType: "local",
        contextWindow: 128000,
        params: 26,
        resolvedModel: "llama-3.3-70b-versatile",
      },
    ],
    modelCooldowns: [
      { model: "editorial-heavy", startedAt: 1000, expiresAt: 2000, reason: "rate limit" },
    ],
  });

  const block = actions.find((action) => action.id === "mutate-policy:model:editorial-heavy:block");
  const probe = actions.find((action) => action.id === "probe:model:editorial-heavy");
  const cooldown = actions.find((action) => action.id === "clear-cooldown:model:editorial-heavy");

  expect(block?.kind).toBe("mutate-policy");
  expect(block?.confirm).toBe(true);
  expect(block?.reasonRequired).toBe(true);
  expect(block?.rollbackHint).toContain("inverse");
  expect(probe?.kind).toBe("probe");
  expect(probe?.risk).toBe("low");
  expect(probe?.confirm).toBe(false);
  expect(probe?.jobKind).toBe("model-single-probe");
  expect(cooldown?.kind).toBe("clear-cooldown");
  expect(cooldown?.risk).toBe("low");
  expect(cooldown?.confirm).toBe(false);
});

test("catalog emits a pin for every configured gateway model and clear only while an override is active", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "gateway-route-descriptors-"));
  const prevDb = process.env.DASHBOARD_DB;
  const prevDbPath = process.env.DASHBOARD_DB_PATH;
  const prevGatewayConfig = process.env.GATEWAY_CONFIG;
  const gatewayConfigPath = join(tempDir, "gateway.yaml");
  writeFileSync(gatewayConfigPath, `
version: 1
litellm_url: http://127.0.0.1:4000
models:
  editorial-heavy:
    backend: litellm
    model: editorial-heavy-resolved
    tier: local
  editorial-fast:
    backend: litellm
    model: editorial-fast-resolved
    tier: cloud-free
`);
  closeDashboardDb();
  resetGatewayRouteOverrideStateForTests();
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.GATEWAY_CONFIG = gatewayConfigPath;
  _resetGatewayConfigCacheForTests();
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  try {
    const configuredModels = Object.keys(loadGatewayConfig().models).sort();
    const withoutOverride = buildActionCatalog({});
    const pinActions = withoutOverride.filter((action) => action.kind === "pin" && action.targetType === "gateway-route");

    expect(pinActions.map((action) => action.targetId).sort()).toEqual(configuredModels);
    expect(pinActions.map((action) => action.id).sort()).toEqual(configuredModels.map((model) => `pin:gateway-route:${model}`));
    for (const action of pinActions) {
      expect(action.risk).toBe("low");
      expect(action.confirm).toBe(true);
      expect(action.reasonRequired).toBe(true);
      expect(action.impactPreview).toContain("4-hour TTL");
      expect(action.impactPreview).toContain("auto-revert");
    }
    expect(withoutOverride.some((action) => action.id === "start-job:gateway:clear-route-override")).toBe(false);

    setGatewayRouteOverrideForGatewayAdmin({
      targetModel: "editorial-heavy",
      resolvedModel: "editorial-heavy-resolved",
      tier: "local",
      ttlMs: 14_400_000,
    });
    const withOverride = buildActionCatalog({});
    const clearAction = withOverride.find((action) => action.id === "start-job:gateway:clear-route-override");
    expect(clearAction?.risk).toBe("low");
    expect(clearAction?.confirm).toBe(true);
    expect(clearAction?.reasonRequired).toBe(true);

    clearGatewayRouteOverrideForGatewayAdmin();
    expect(buildActionCatalog({}).some((action) => action.id === "start-job:gateway:clear-route-override")).toBe(false);
  } finally {
    resetGatewayRouteOverrideStateForTests();
    closeDashboardDb();
    if (prevDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = prevDb;
    if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = prevDbPath;
    if (prevGatewayConfig === undefined) delete process.env.GATEWAY_CONFIG;
    else process.env.GATEWAY_CONFIG = prevGatewayConfig;
    _resetGatewayConfigCacheForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("catalog emits rotate descriptors only for active gateway keys without pending grace", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "gateway-key-descriptors-"));
  const prevDb = process.env.DASHBOARD_DB;
  const prevDbPath = process.env.DASHBOARD_DB_PATH;
  closeDashboardDb();
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  try {
    const now = Date.now();
    const rows = [
      ["key-active", "active key", "active", null],
      ["key-pending", "pending key", "active", now + 60_000],
      ["key-revoked", "revoked key", "revoked", null],
    ] as const;
    for (const [id, name, status, rotationRevokeAt] of rows) {
      getDashboardDb()!.query(`
        INSERT INTO gateway_keys
          (id, agent_id, name, key_hash, model_allowlist, daily_cap_usd, status, created_at, last_used_at, tenant_id, rotated_from_key_id, rotation_revoke_at)
        VALUES (?, 'agent-a', ?, ?, '', NULL, ?, ?, NULL, 'mimule', NULL, ?)
      `).run(id, name, `${id}-hash`, status, now, rotationRevokeAt);
    }

    const actions = buildActionCatalog({});
    const rotateActions = actions.filter((action) => action.kind === "rotate" && action.targetType === "gateway-key");

    expect(rotateActions.map((action) => action.id)).toEqual(["rotate:gateway-key:key-active"]);
    expect(rotateActions[0].label).toContain("active key");
    expect(rotateActions[0].risk).toBe("medium");
    expect(rotateActions[0].confirm).toBe(true);
    expect(rotateActions[0].reasonRequired).toBe(true);
  } finally {
    closeDashboardDb();
    if (prevDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = prevDb;
    if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = prevDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
