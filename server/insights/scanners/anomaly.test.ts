import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../../db/dashboard.ts";
import { whereTenant, withTenantInsert } from "../../db/tenantScope.ts";
import { aggregateInsights } from "../aggregate.ts";
import { listInsights } from "../store.ts";
import { runAnomalyScan } from "./anomaly.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "anomaly-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function db() {
  return getDashboardDb()!;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function seedCall(ts: number, logicalModel: string, caller: string, costUsd: number): void {
  const tenant = whereTenant();
  db().query(`
    INSERT INTO gateway_calls
      (ts, logical_model, resolved_model, backend, tier, cost_estimate_usd, success, caller, tenant_id)
    VALUES (?, ?, ?, 'demo', 'cloud-free', ?, 1, ?, ?)
  `).run(ts, logicalModel, logicalModel, costUsd, caller, tenant.params[0]);
}

describe("anomaly scanner", () => {
  test("inserts exactly one spend_anomalies row when today spikes above baseline; second scan dedupes", () => {
    const tenant = whereTenant();
    const tenantId = tenant.params[0];
    const todayStart = startOfUtcDay(Date.now());
    const now = Date.now();

    for (let dayOffset = 8; dayOffset >= 1; dayOffset -= 1) {
      const dayTs = todayStart - dayOffset * ONE_DAY_MS;
      for (let i = 0; i < 10; i += 1) {
        seedCall(dayTs + i * 1000, "modelX", "callerA", 0.05);
      }
    }

    for (let i = 0; i < 40; i += 1) {
      seedCall(todayStart + i * 1000, "modelX", "callerA", 0.05);
    }

    const first = runAnomalyScan();
    expect(first.anomalies).toBe(1);

    const rows = db().query(
      `SELECT id, scope_type, scope_id, baseline_cents, observed_cents, multiplier, status
       FROM spend_anomalies WHERE scope_type = 'cost:anomaly-scan' ${tenant.clause}`,
    ).all(...tenant.params) as Array<{
      id: string;
      scope_type: string;
      scope_id: string | null;
      baseline_cents: number;
      observed_cents: number;
      multiplier: number;
      status: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].scope_id).toBe("modelX|callerA");
    expect(rows[0].status).toBe("open");
    expect(rows[0].multiplier).toBeGreaterThan(3);

    const second = runAnomalyScan();
    expect(second.anomalies).toBe(0);

    const countAfter = db().query(
      `SELECT COUNT(*) AS n FROM spend_anomalies WHERE scope_type = 'cost:anomaly-scan' ${tenant.clause}`,
    ).get(...tenant.params) as { n: number };
    expect(countAfter.n).toBe(1);

    aggregateInsights();
    const insightRows = listInsights("open");
    const anomalyInsight = insightRows.find((row) => row.sourceKey?.startsWith("cost:spend_anomaly:") && row.sourceKey.endsWith(rows[0].id));
    expect(anomalyInsight).toBeDefined();
    expect(anomalyInsight!.domain).toBe("cost");
    expect(anomalyInsight!.status).toBe("open");
  });

  test("does not insert when today is below the call multiplier or call floor", () => {
    const todayStart = startOfUtcDay(Date.now());

    for (let dayOffset = 8; dayOffset >= 1; dayOffset -= 1) {
      const dayTs = todayStart - dayOffset * ONE_DAY_MS;
      for (let i = 0; i < 10; i += 1) {
        seedCall(dayTs + i * 1000, "modelX", "callerA", 0.05);
      }
    }

    for (let i = 0; i < 12; i += 1) {
      seedCall(todayStart + i * 1000, "modelX", "callerA", 0.05);
    }

    const result = runAnomalyScan();
    expect(result.anomalies).toBe(0);

    const tenant = whereTenant();
    const count = db().query(
      `SELECT COUNT(*) AS n FROM spend_anomalies WHERE scope_type = 'cost:anomaly-scan' ${tenant.clause}`,
    ).get(...tenant.params) as { n: number };
    expect(count.n).toBe(0);
  });

  test("does not insert when fewer than 3 baseline days have activity", () => {
    const todayStart = startOfUtcDay(Date.now());

    for (let dayOffset = 2; dayOffset >= 1; dayOffset -= 1) {
      const dayTs = todayStart - dayOffset * ONE_DAY_MS;
      for (let i = 0; i < 10; i += 1) {
        seedCall(dayTs + i * 1000, "modelX", "callerA", 0.05);
      }
    }

    for (let i = 0; i < 50; i += 1) {
      seedCall(todayStart + i * 1000, "modelX", "callerA", 0.05);
    }

    const result = runAnomalyScan();
    expect(result.anomalies).toBe(0);
  });

  test("aggregateInsights picks up the row and emits a cost:spend_anomaly: sourceKey", () => {
    const todayStart = startOfUtcDay(Date.now());
    const tenant = withTenantInsert(undefined, {
      id: "spend-anomaly-agg-1",
      ts: todayStart,
      scope_type: "cost:anomaly-scan",
      scope_id: "modelY|callerB",
      baseline_cents: 50,
      observed_cents: 200,
      multiplier: 4,
      status: "open",
    });
    db().query(`
      INSERT INTO spend_anomalies
        (id, tenant_id, ts, scope_type, scope_id, baseline_cents, observed_cents, multiplier, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenant.id,
      tenant.tenant_id,
      tenant.ts,
      tenant.scope_type,
      tenant.scope_id,
      tenant.baseline_cents,
      tenant.observed_cents,
      tenant.multiplier,
      tenant.status,
    );

    runAnomalyScan();

    const result = aggregateInsights();
    const rows = listInsights("open");
    const matched = rows.find((row) => row.sourceKey === "cost:spend_anomaly:spend-anomaly-agg-1");
    expect(matched).toBeDefined();
    expect(matched!.domain).toBe("cost");
    expect(result.createdOrUpdated).toBeGreaterThanOrEqual(1);
  });
});
