import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { getDashboardDb, initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";

const TEST_DB = "/tmp/test-reports-control-surface.db";

function setupTestDb(): Database {
  rmSync(TEST_DB, { force: true });
  closeDashboardDb();
  return initDashboardDb({ enabled: true, path: TEST_DB })!;
}

describe("reportsTemplatesHandler", () => {
  it("returns array of templates", async () => {
    const db = setupTestDb();
    const mod = await import("./reports.ts");
    const response = mod.reportsTemplatesHandler();
    const json = await response.json();
    expect(json.data).toBeDefined();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data[0].id).toBe("gateway-calls");
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });
});

describe("reportsRunHandler", () => {
  let db: Database;

  beforeEach(() => {
    db = setupTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_audit (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        actor TEXT,
        action_kind TEXT NOT NULL,
        result_status TEXT,
        tenant_id TEXT
      );
    `);
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });

  it("runs gateway-calls report", async () => {
    const now = Date.now();
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, tenant_id) VALUES (?, ?, ?, ?)`,
    ).run(now, "alice", "gateway.call", "mimule");

    const mod = await import("./reports.ts");
    const req = new Request("http://localhost/api/reports/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "gateway-calls", params: { tenantId: "mimule", fromTs: 0, toTs: now + 1000 } }),
    });
    const response = await mod.reportsRunHandler(req);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data?.output?.rows).toBeDefined();
    expect(json.data.output.rows.length).toBe(1);
  });

  it("returns denied actions only", async () => {
    const now = Date.now();
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, result_status, tenant_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(now, "alice", "action.execute", "denied", "mimule");
    db.query(
      `INSERT INTO action_audit (ts, actor, action_kind, result_status, tenant_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(now + 1, "bob", "action.execute", "success", "mimule");

    const mod = await import("./reports.ts");
    const req = new Request("http://localhost/api/reports/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "denied-actions", params: { tenantId: "mimule", fromTs: 0, toTs: now + 1000 } }),
    });
    const response = await mod.reportsRunHandler(req);
    const json = await response.json();
    expect(json.data?.output?.rows).toBeDefined();
    expect(json.data.output.rows.length).toBe(1);
    expect(json.data.output.rows[0].result_status).toBe("denied");
  });
});

describe("reportsDownloadCsvHandler", () => {
  let db: Database;

  beforeEach(() => {
    db = setupTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        template_id TEXT,
        params_json TEXT,
        status TEXT,
        output_json TEXT,
        row_count INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT
      );
    `);
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });

  it("returns CSV content type", async () => {
    const runId = "test-run-123";
    db.query(
      `INSERT INTO report_runs (id, tenant_id, template_id, status, output_json, row_count, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, "mimule", "gateway-calls", "success", '{"rows":[{"a":"1","b":"2"}]}', 1, Date.now(), Date.now());

    const mod = await import("./reports.ts");
    const response = await mod.reportsDownloadCsvHandler(new Request("http://localhost"), runId);
    expect(response.headers.get("Content-Type")).toBe("text/csv");
  });

  it("returns correct CSV header for a gateway-calls run", async () => {
    const runId = "test-run-csv-header";
    db.query(
      `INSERT INTO report_runs (id, tenant_id, template_id, status, output_json, row_count, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, "mimule", "gateway-calls", "success", '{"rows":[{"ts":"123","actor":"alice","action_kind":"gateway.call"}]}', 1, Date.now(), Date.now());

    const mod = await import("./reports.ts");
    const response = await mod.reportsDownloadCsvHandler(new Request("http://localhost"), runId);
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.split("\n");
    expect(lines[0]).toBe("ts,actor,action_kind");
  });
});