import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../../db/dashboard.ts";
import { whereTenant } from "../../db/tenantScope.ts";
import { runSentinelIncidentScan } from "./sentinelIncidents.ts";

let tempDir: string;
let prevHealth: string | undefined;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "sentinel-incidents-test-"));
  prevHealth = process.env.SENTINEL_HEALTH_PATH;
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevHealth === undefined) delete process.env.SENTINEL_HEALTH_PATH;
  else process.env.SENTINEL_HEALTH_PATH = prevHealth;
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function db() {
  return getDashboardDb()!;
}

function writeHealth(contents: Record<string, unknown>): string {
  const path = join(tempDir, "product-health.json");
  writeFileSync(path, JSON.stringify(contents), "utf8");
  process.env.SENTINEL_HEALTH_PATH = path;
  return path;
}

function readIncidentRows(): Array<{
  id: string;
  cluster_key: string;
  title: string;
  failure_class: string;
  occurrence_count: number;
  status: string;
  representative_pass_id: string;
  first_seen: number;
  sla_due_at: number | null;
}> {
  const tenant = whereTenant();
  return db().query(`
    SELECT id, cluster_key, title, failure_class, occurrence_count, status, representative_pass_id,
           first_seen, sla_due_at
    FROM reasoner_incidents
    WHERE 1=1 ${tenant.clause}
    ORDER BY first_seen ASC
  `).all(...tenant.params) as Array<{
    id: string;
    cluster_key: string;
    title: string;
    failure_class: string;
    occurrence_count: number;
    status: string;
    representative_pass_id: string;
    first_seen: number;
    sla_due_at: number | null;
  }>;
}

describe("sentinel incident scanner", () => {
  test("creates a reasoner_incident row for each fail finding", () => {
    writeHealth({
      score: 60,
      fails: 2,
      warns: 0,
      findings: [
        { id: "/", name: "Home page down", status: "fail", severity: "high" },
        { id: "page/api-version", name: "API version page 500", status: "fail", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });

    const result = runSentinelIncidentScan();
    expect(result.scanned).toBe(2);
    expect(result.createdOrUpdated).toBe(2);
    expect(result.deduped).toBe(0);

    const rows = readIncidentRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.failure_class === "sentinel_health")).toBe(true);
    expect(rows.every((r) => r.status === "open")).toBe(true);
    expect(rows.find((r) => r.title.includes("Home page down"))).toBeDefined();
  });

  test("sets sla_due_at at creation using the window matching the title's severity prefix", () => {
    writeHealth({
      score: 40,
      fails: 2,
      warns: 0,
      findings: [
        { id: "/", name: "Home page down", status: "fail", severity: "critical" },
        { id: "data-freshness", name: "Data freshness lagging", status: "fail", severity: "medium" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });

    runSentinelIncidentScan();
    const rows = readIncidentRows();

    const critical = rows.find((r) => r.title.startsWith("[critical/"));
    expect(critical).toBeDefined();
    expect(critical!.sla_due_at).toBe(critical!.first_seen + 4 * 60 * 60 * 1000);

    const medium = rows.find((r) => r.title.startsWith("[medium/"));
    expect(medium).toBeDefined();
    expect(medium!.sla_due_at).toBe(medium!.first_seen + 72 * 60 * 60 * 1000);
  });

  test("high impact rank is reflected in title for page/ and / findings; medium for others", () => {
    writeHealth({
      score: 60,
      fails: 2,
      warns: 0,
      findings: [
        { id: "/", name: "Home page", status: "fail", severity: "critical" },
        { id: "data-freshness", name: "Data freshness lagging", status: "fail", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });

    runSentinelIncidentScan();
    const rows = readIncidentRows();
    const home = rows.find((r) => r.title.includes("Home page"));
    const data = rows.find((r) => r.title.includes("Data freshness"));
    expect(home).toBeDefined();
    expect(home!.title).toMatch(/^\[(critical|high)\/high\]/);
    expect(data).toBeDefined();
    expect(data!.title).toMatch(/^\[high\/medium\]/);
  });

  test("dedupes per finding id per UTC day (second scan increments occurrence_count, no new row)", () => {
    writeHealth({
      score: 60,
      fails: 1,
      warns: 0,
      findings: [
        { id: "/", name: "Home page down", status: "fail", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });

    const first = runSentinelIncidentScan();
    expect(first.createdOrUpdated).toBe(1);
    expect(first.deduped).toBe(0);

    const second = runSentinelIncidentScan();
    expect(second.createdOrUpdated).toBe(0);
    expect(second.deduped).toBe(1);

    const rows = readIncidentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrence_count).toBe(2);

    const third = runSentinelIncidentScan();
    expect(third.createdOrUpdated).toBe(0);
    expect(third.deduped).toBe(1);
    const rows2 = readIncidentRows();
    expect(rows2).toHaveLength(1);
    expect(rows2[0].occurrence_count).toBe(3);
  });

  test("ignores warn findings (only fail creates incidents)", () => {
    writeHealth({
      score: 88,
      fails: 0,
      warns: 2,
      findings: [
        { id: "agent-opencode-roundtrip", name: "opencode slow", status: "warn", severity: "warn" },
        { id: "agent-gemini-roundtrip", name: "gemini quota", status: "warn", severity: "warn" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });

    const result = runSentinelIncidentScan();
    expect(result.scanned).toBe(0);
    expect(result.createdOrUpdated).toBe(0);
    expect(readIncidentRows()).toHaveLength(0);
  });

  test("returns safely when sentinel health file is missing", () => {
    process.env.SENTINEL_HEALTH_PATH = join(tempDir, "does-not-exist.json");
    const result = runSentinelIncidentScan();
    expect(result.scanned).toBe(0);
    expect(result.createdOrUpdated).toBe(0);
    expect(result.deduped).toBe(0);
  });

  test("auto-close: clears when finding passes on rescan", () => {
    writeHealth({
      score: 60,
      fails: 1,
      warns: 0,
      findings: [
        { id: "page/api-version", name: "API version page 500", status: "fail", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });
    const first = runSentinelIncidentScan();
    expect(first.createdOrUpdated).toBe(1);
    expect(readIncidentRows()).toHaveLength(1);
    expect(readIncidentRows()[0].status).toBe("open");

    writeHealth({
      score: 100,
      fails: 0,
      warns: 0,
      findings: [
        { id: "page/api-version", name: "API version page 500", status: "ok", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });
    const second = runSentinelIncidentScan();
    expect(second.autoClosed).toBe(1);

    const rows = readIncidentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("resolved");
  });

  test("auto-close: clears when finding disappears and zero fails (removed early-return)", () => {
    writeHealth({
      score: 60,
      fails: 1,
      warns: 0,
      findings: [
        { id: "page/api-version", name: "API version page 500", status: "fail", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });
    const first = runSentinelIncidentScan();
    expect(first.createdOrUpdated).toBe(1);

    writeHealth({
      score: 100,
      fails: 0,
      warns: 0,
      findings: [],
      checkedAt: Math.floor(Date.now() / 1000),
    });
    const second = runSentinelIncidentScan();
    expect(second.scanned).toBe(0);
    expect(second.autoClosed).toBe(1);

    const rows = readIncidentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("resolved");
  });

  test("auto-close: does not close a still-failing finding", () => {
    writeHealth({
      score: 60,
      fails: 1,
      warns: 0,
      findings: [
        { id: "page/api-version", name: "API version page 500", status: "fail", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });
    runSentinelIncidentScan();

    writeHealth({
      score: 60,
      fails: 1,
      warns: 0,
      findings: [
        { id: "page/api-version", name: "API version page 500", status: "fail", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });
    const second = runSentinelIncidentScan();
    expect(second.autoClosed).toBe(0);

    const rows = readIncidentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
    expect(rows[0].occurrence_count).toBe(2);
  });

  test("auto-close: missing card does not auto-close", () => {
    writeHealth({
      score: 60,
      fails: 1,
      warns: 0,
      findings: [
        { id: "page/api-version", name: "API version page 500", status: "fail", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });
    runSentinelIncidentScan();

    process.env.SENTINEL_HEALTH_PATH = join(tempDir, "does-not-exist.json");
    const second = runSentinelIncidentScan();
    expect(second.autoClosed).toBe(0);

    const rows = readIncidentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
  });

  test("auto-close: stale card does not auto-close", () => {
    writeHealth({
      score: 60,
      fails: 1,
      warns: 0,
      findings: [
        { id: "page/api-version", name: "API version page 500", status: "fail", severity: "high" },
      ],
      checkedAt: Math.floor(Date.now() / 1000),
    });
    runSentinelIncidentScan();

    const staleCheckedAt = Math.floor(Date.now() / 1000) - 7 * 60 * 60;
    writeHealth({
      score: 100,
      fails: 0,
      warns: 0,
      findings: [
        { id: "page/api-version", name: "API version page 500", status: "ok", severity: "high" },
      ],
      checkedAt: staleCheckedAt,
    });
    const second = runSentinelIncidentScan();
    expect(second.autoClosed).toBe(0);

    const rows = readIncidentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
  });

  test("auto-close: never touches non-sentinel incidents", () => {
    const tenant = whereTenant();
    const tenantId = tenant.params[0];
    db().query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen, occurrence_count,
         representative_pass_id, representative_diagnosis_id, status, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'open', ?)
    `).run(
      "ri_other",
      "other-cluster-key",
      "other_class",
      "Some other incident",
      Date.now(),
      Date.now(),
      "other:rep",
      "other:rep",
      tenantId,
    );

    writeHealth({
      score: 100,
      fails: 0,
      warns: 0,
      findings: [],
      checkedAt: Math.floor(Date.now() / 1000),
    });
    const result = runSentinelIncidentScan();
    expect(result.autoClosed).toBe(0);

    const rows = readIncidentRows();
    const other = rows.find((r) => r.id === "ri_other");
    expect(other).toBeDefined();
    expect(other!.status).toBe("open");
  });
});
