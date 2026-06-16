import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { getDashboardDb, initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";

const TEST_DB = "/tmp/test-reports-control-surface.db";
const TEST_VAULT_DIR = "/tmp/test-reports-ai-vault";

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
        target TEXT,
        target_type TEXT,
        action_kind TEXT NOT NULL,
        result TEXT,
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
      `INSERT INTO gateway_calls (ts, logical_model, resolved_model, backend, tier, success, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, "model-a", "provider/model-a", "litellm", "free", 1, "mimule");

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
    expect(json.data.output.rows[0].logical_model).toBe("model-a");
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

  it("runs daily pipeline and weekly content health reports", async () => {
    const now = Date.now();
    db.query(
      `INSERT INTO action_audit (ts, actor, target, target_type, action_kind, result_status, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, "system", "autopipeline", "autopipeline", "autopipeline.command", "success", "mimule");
    db.query(
      `INSERT INTO events (ts, kind, severity, entity_type, entity_id, summary, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, "article.missing_image", "warn", "article", "story-a", "Missing image", "mimule");

    const mod = await import("./reports.ts");
    const dailyReq = new Request("http://localhost/api/reports/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "daily-pipeline", params: { tenantId: "mimule", fromTs: now - 1, toTs: now + 1 } }),
    });
    const daily = await mod.reportsRunHandler(dailyReq);
    const dailyJson = await daily.json();
    expect(daily.status).toBe(200);
    expect(dailyJson.data.output.rows[0].action_kind).toBe("autopipeline.command");

    const weeklyReq = new Request("http://localhost/api/reports/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "weekly-content-health", params: { tenantId: "mimule", fromTs: now - 1, toTs: now + 1 } }),
    });
    const weekly = await mod.reportsRunHandler(weeklyReq);
    const weeklyJson = await weekly.json();
    expect(weekly.status).toBe(200);
    expect(weeklyJson.data.output.rows[0].kind).toBe("article.missing_image");
  });

  it("lists report archive runs", async () => {
    const now = Date.now();
    db.query(
      `INSERT INTO report_runs (id, tenant_id, template_id, params_json, status, output_json, row_count, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("run-archive", "mimule", "daily-pipeline", "{}", "success", '{"rows":[]}', 0, now, now);

    const mod = await import("./reports.ts");
    const response = mod.reportsListHandler(new Request("http://localhost/api/reports?limit=10"));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.runs[0].id).toBe("run-archive");
    expect(json.data.summary[0].templateId).toBe("daily-pipeline");
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

describe("reportsExportVaultHandler", () => {
  let db: Database;

  beforeEach(() => {
    db = setupTestDb();
    process.env.DASHBOARD_REPORTS_VAULT_DIR = TEST_VAULT_DIR;
    rmSync(TEST_VAULT_DIR, { force: true, recursive: true });
  });

  afterEach(() => {
    delete process.env.DASHBOARD_REPORTS_VAULT_DIR;
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
    rmSync(TEST_VAULT_DIR, { force: true, recursive: true });
  });

  it("exports a successful daily pipeline report to the configured vault path", async () => {
    const now = Date.UTC(2026, 5, 11, 12, 0, 0);
    db.query(
      `INSERT INTO report_runs (id, tenant_id, template_id, params_json, status, output_json, row_count, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-vault-success",
      "mimule",
      "daily-pipeline",
      "{}",
      "success",
      '{"rows":[{"action_kind":"autopipeline.command","result_status":"success","count":2}]}',
      1,
      now,
      now,
    );

    const mod = await import("./reports.ts");
    const response = await mod.reportsExportVaultHandler(new Request("http://localhost/api/reports/run-vault-success/export-vault", { method: "POST" }), "run-vault-success");
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.path).toBe(`${TEST_VAULT_DIR}/daily/2026-06-11-pipeline.md`);
    expect(existsSync(json.data.path)).toBe(true);
    const content = readFileSync(json.data.path, "utf8");
    expect(content).toContain("# Daily Pipeline Report");
    expect(content).toContain("autopipeline.command");
  });

  it("rejects export for incomplete report runs", async () => {
    const now = Date.now();
    db.query(
      `INSERT INTO report_runs (id, tenant_id, template_id, params_json, status, output_json, row_count, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("run-vault-running", "mimule", "daily-pipeline", "{}", "running", "", 0, now, null);

    const mod = await import("./reports.ts");
    const response = await mod.reportsExportVaultHandler(new Request("http://localhost/api/reports/run-vault-running/export-vault", { method: "POST" }), "run-vault-running");
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toBe("run not completed");
  });
});
