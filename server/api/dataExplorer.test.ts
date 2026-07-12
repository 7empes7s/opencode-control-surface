import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { handleApi } from "./router.ts";

describe("data explorer API", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;
  let previousOperatorToken: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "data-explorer-api-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    previousOperatorToken = process.env.OPERATOR_TOKEN;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    process.env.OPERATOR_TOKEN = "data-explorer-test-token";
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  });

  afterEach(() => {
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousOperatorToken;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function req(path: string) {
    return new Request(`http://localhost${path}`, {
      headers: { "x-operator-token": "data-explorer-test-token" },
    });
  }

  function seedInsight(id: string, title: string, sourceKey: string) {
    getDashboardDb()!.query(`
      INSERT INTO insights
        (id, domain, severity, title, plain_summary, confidence, evidence_refs_json,
         action_descriptor_id, manual_page_href, status, tenant_id, created_at, source_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      "ops",
      "high",
      title,
      "Seed summary",
      0.9,
      "[]",
      null,
      "/incidents",
      "open",
      "mimule",
      Date.now(),
      sourceKey,
    );
  }

  it("lists allowlisted tables with row counts", async () => {
    seedInsight("insight-a", "Explorer seed", "ops:secret-source");

    const request = req("/api/data-explorer/tables");
    const res = await handleApi(request, new URL(request.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { tables: Array<{ name: string; rowCount: number }> } };

    expect(body.data.tables.some((table) => table.name === "insights" && table.rowCount === 1)).toBe(true);
    expect(body.data.tables.some((table) => table.name === "system_configs")).toBe(false);
  });

  it("returns allowlisted rows and redacts sensitive column names", async () => {
    seedInsight("insight-b", "Sensitive column seed", "ops:token-like-value");

    const request = req("/api/data-explorer/table/insights?limit=20&q=Sensitive");
    const res = await handleApi(request, new URL(request.url));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        rows: Array<Record<string, unknown>>;
        table: { columns: Array<{ name: string; redacted: boolean }> };
      };
    };

    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0].title).toBe("Sensitive column seed");
    expect(body.data.rows[0].source_key).toBe("***");
    expect(body.data.table.columns.find((column) => column.name === "source_key")?.redacted).toBe(true);
  });

  it("rejects non-allowlisted table names with 404", async () => {
    const request = req("/api/data-explorer/table/system_configs");
    const res = await handleApi(request, new URL(request.url));

    expect(res.status).toBe(404);
  });

  it("clamps requested limit to 200", async () => {
    for (let index = 0; index < 5; index += 1) {
      seedInsight(`insight-limit-${index}`, `Limit seed ${index}`, `ops:key:${index}`);
    }

    const request = req("/api/data-explorer/table/insights?limit=999");
    const res = await handleApi(request, new URL(request.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { limit: number; rows: unknown[] } };

    expect(body.data.limit).toBe(200);
    expect(body.data.rows).toHaveLength(5);
  });
});
