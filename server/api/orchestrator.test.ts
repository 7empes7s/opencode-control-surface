import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  orchestratorSignalsListHandler,
  orchestratorLanesHandler,
} from "./orchestrator.ts";
import { emitSignal } from "../orchestrator/signals.ts";
import { setLaneLimit } from "../orchestrator/lanes.ts";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";

function withTenant<R>(tenantId: string, fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "orchestrator-api-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("orchestrator API tenant isolation", () => {
  test("signals list only returns current tenant signals", async () => {
    withTenant("tenant-a", () => {
      emitSignal("inst-1", "sig-a", { data: 1 }, "tenant-a");
    });
    withTenant("tenant-b", () => {
      emitSignal("inst-1", "sig-b", { data: 2 }, "tenant-b");
    });

    const resA = await withTenant("tenant-a", () => orchestratorSignalsListHandler(new URL("http://localhost/api/orchestrator/signals")));
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { signals: Array<{ signalName: string }> };
    expect(bodyA.signals.length).toBe(1);
    expect(bodyA.signals[0].signalName).toBe("sig-a");

    const resB = await withTenant("tenant-b", () => orchestratorSignalsListHandler(new URL("http://localhost/api/orchestrator/signals")));
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { signals: Array<{ signalName: string }> };
    expect(bodyB.signals.length).toBe(1);
    expect(bodyB.signals[0].signalName).toBe("sig-b");
  });

  test("lanes list only returns current tenant lanes", async () => {
    withTenant("tenant-a", () => {
      setLaneLimit("lane-a", 2, "tenant-a");
    });
    withTenant("tenant-b", () => {
      setLaneLimit("lane-b", 3, "tenant-b");
    });

    const resA = await withTenant("tenant-a", () => orchestratorLanesHandler());
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as { lanes: Array<{ laneName: string }> };
    expect(bodyA.lanes.length).toBe(1);
    expect(bodyA.lanes[0].laneName).toBe("lane-a");

    const resB = await withTenant("tenant-b", () => orchestratorLanesHandler());
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as { lanes: Array<{ laneName: string }> };
    expect(bodyB.lanes.length).toBe(1);
    expect(bodyB.lanes[0].laneName).toBe("lane-b");
  });
});
