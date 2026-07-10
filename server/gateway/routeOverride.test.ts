import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import {
  clearGatewayRouteOverrideForGatewayAdmin,
  getGatewayRouteOverrideForGatewayAdmin,
  getGatewayRoutePlanForGatewayAdmin,
  resetGatewayRouteOverrideStateForTests,
  setGatewayRouteOverrideForGatewayAdmin,
} from "./router.ts";

describe("gateway route override persistence", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    resetGatewayRouteOverrideStateForTests();
    tempDir = mkdtempSync(join(tmpdir(), "gateway-route-override-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    resetGatewayRouteOverrideStateForTests();
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("pin persists across a simulated restart and remains first in the route plan", () => {
    setGatewayRouteOverrideForGatewayAdmin({
      targetModel: "pinned-model",
      resolvedModel: "resolved-pinned-model",
      tier: "local",
      reason: "keep local tonight",
      setBy: "test-operator",
      ttlMs: 4 * 60 * 60_000,
    });

    expect(getGatewayRoutePlanForGatewayAdmin("editorial-heavy")[0]).toBe("pinned-model");

    resetGatewayRouteOverrideStateForTests();

    expect(getGatewayRouteOverrideForGatewayAdmin()?.targetModel).toBe("pinned-model");
    expect(getGatewayRoutePlanForGatewayAdmin("editorial-heavy")[0]).toBe("pinned-model");
  });

  test("TTL is clamped between 60 seconds and 7 days", () => {
    const shortStartedAt = Date.now();
    const shortOverride = setGatewayRouteOverrideForGatewayAdmin({
      targetModel: "short-pin",
      resolvedModel: "short-pin",
      tier: "local",
      ttlMs: 1_000,
    });
    const shortTtl = Date.parse(shortOverride.expiresAt) - shortStartedAt;
    expect(shortTtl).toBeGreaterThanOrEqual(60_000);
    expect(shortTtl).toBeLessThan(61_500);

    const longStartedAt = Date.now();
    const longOverride = setGatewayRouteOverrideForGatewayAdmin({
      targetModel: "long-pin",
      resolvedModel: "long-pin",
      tier: "cloud-free",
      ttlMs: 30 * 86_400_000,
    });
    const longTtl = Date.parse(longOverride.expiresAt) - longStartedAt;
    expect(longTtl).toBeGreaterThanOrEqual(7 * 86_400_000);
    expect(longTtl).toBeLessThan(7 * 86_400_000 + 1_500);
  });

  test("an expired persisted pin auto-reverts, deletes its row, and writes an audit", () => {
    setGatewayRouteOverrideForGatewayAdmin({
      targetModel: "expired-pin",
      resolvedModel: "expired-pin",
      tier: "local",
      ttlMs: 60_000,
    });
    getDashboardDb()!.query("UPDATE gateway_route_override SET expires_at = ? WHERE id = 1")
      .run(new Date(Date.now() - 1_000).toISOString());

    resetGatewayRouteOverrideStateForTests();

    expect(getGatewayRouteOverrideForGatewayAdmin()).toBeNull();
    const overrideRow = getDashboardDb()!.query("SELECT id FROM gateway_route_override WHERE id = 1").get();
    expect(overrideRow).toBeNull();
    const auditRow = getDashboardDb()!.query(`
      SELECT action_kind, actor, target_type, target_id, risk, result_status
      FROM action_audit
      WHERE action_kind = 'gateway.route-override-expired'
      ORDER BY id DESC
      LIMIT 1
    `).get() as {
      action_kind: string;
      actor: string;
      target_type: string;
      target_id: string;
      risk: string;
      result_status: string;
    } | null;
    expect(auditRow).toEqual({
      action_kind: "gateway.route-override-expired",
      actor: "gateway",
      target_type: "gateway-route",
      target_id: "expired-pin",
      risk: "low",
      result_status: "success",
    });
  });

  test("clear removes the in-memory and persisted override and is idempotent", () => {
    setGatewayRouteOverrideForGatewayAdmin({
      targetModel: "clear-pin",
      resolvedModel: "clear-pin",
      tier: "local",
    });

    clearGatewayRouteOverrideForGatewayAdmin();

    expect(getGatewayRouteOverrideForGatewayAdmin()).toBeNull();
    expect(getDashboardDb()!.query("SELECT id FROM gateway_route_override WHERE id = 1").get()).toBeNull();
    expect(() => clearGatewayRouteOverrideForGatewayAdmin()).not.toThrow();
    expect(getGatewayRouteOverrideForGatewayAdmin()).toBeNull();
  });
});
