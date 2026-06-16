import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { getCostSummary } from "./cost.ts";

const TEST_DB = "/tmp/test-cost-control-surface.db";

function setupTestDb() {
  rmSync(TEST_DB, { force: true });
  closeDashboardDb();
  return initDashboardDb({ enabled: true, path: TEST_DB })!;
}

describe("getCostSummary", () => {
  const previousDashboardDb = process.env.DASHBOARD_DB;

  beforeEach(() => {
    process.env.DASHBOARD_DB = "1";
    setupTestDb();
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });

    if (previousDashboardDb === undefined) {
      delete process.env.DASHBOARD_DB;
    } else {
      process.env.DASHBOARD_DB = previousDashboardDb;
    }
  });

  it("returns recent cost anomaly detector events", async () => {
    const now = Date.now();
    const db = getDashboardDb();
    expect(db).not.toBeNull();
    db!.query(`
      INSERT INTO events (ts, kind, severity, entity_type, entity_id, summary, payload_json, dedupe_key, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now - 1_000,
      "vast.burn_spike",
      "error",
      "vast",
      "burn_rate",
      "Vast burn spike: $3.00/h vs $1.00/h baseline (3x)",
      JSON.stringify({ currentHourlyRate: 3, baselineHourlyRate: 1, multiplier: 3 }),
      "test-vast-burn-spike",
      "mimule",
    );
    db!.query(`
      INSERT INTO events (ts, kind, severity, entity_type, entity_id, summary, payload_json, dedupe_key, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now - 2_000,
      "infra.disk_pressure",
      "warn",
      "hetzner",
      "disk",
      "Not a cost anomaly",
      JSON.stringify({ diskUsedPct: 86 }),
      "test-disk-pressure",
      "mimule",
    );

    const response = await getCostSummary(new Request("http://127.0.0.1/api/cost/summary"));
    const json = await response.json() as {
      anomalies: Array<{ kind: string; severity: string; entityId: string; payload: { multiplier?: number } }>;
    };

    expect(response.status).toBe(200);
    expect(json.anomalies).toHaveLength(1);
    expect(json.anomalies[0].kind).toBe("vast.burn_spike");
    expect(json.anomalies[0].severity).toBe("error");
    expect(json.anomalies[0].entityId).toBe("burn_rate");
    expect(json.anomalies[0].payload.multiplier).toBe(3);

  });
});
