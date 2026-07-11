import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateDpa, listSubprocessors, getSoc2Mapping } from "../compliance/generator.ts";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { complianceDpaHandler, complianceSubprocessorsHandler, complianceSoc2MappingHandler, complianceSummaryHandler } from "./compliance.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "./router.ts";

const TEST_DB = "/tmp/test-compliance-control-surface.db";
const TEST_OPERATOR_TOKEN = "compliance-test-token";
let previousOperatorToken: string | undefined;

beforeEach(() => {
  previousOperatorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = TEST_OPERATOR_TOKEN;
});

afterEach(() => {
  if (previousOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousOperatorToken;
});

function setupTestDb() {
  rmSync(TEST_DB, { force: true });
  closeDashboardDb();
  return initDashboardDb({ enabled: true, path: TEST_DB })!;
}

describe("compliance generator", () => {
  it("DPA fills all placeholders", () => {
    const dpa = generateDpa("tenant-abc", "Acme Corp", "2026-01-01");
    expect(dpa).toContain("Acme Corp");
    expect(dpa).toContain("2026-01-01");
    expect(dpa).toContain("tenant-abc");
    expect(dpa).not.toContain("{{CUSTOMER_NAME}}");
    expect(dpa).not.toContain("{{EFFECTIVE_DATE}}");
    expect(dpa).not.toContain("{{TENANT_ID}}");
    expect(dpa).not.toContain("{{RETENTION_DAYS}}");
    expect(dpa).not.toContain("{{GENERATED_DATE}}");
  });

  it("subprocessors list is non-empty", () => {
    const subproc = listSubprocessors();
    expect(subproc.length).toBeGreaterThan(0);
    expect(subproc[0]).toBeTruthy();
  });

  it("SOC2 mapping has entries for CC6/CC7/CC8/CC9", () => {
    const mapping = getSoc2Mapping();
    const criteria = mapping.map((m) => m.criteria);
    expect(criteria.some((c) => c.startsWith("CC6"))).toBe(true);
    expect(criteria.some((c) => c.startsWith("CC7"))).toBe(true);
    expect(criteria.some((c) => c.startsWith("CC8"))).toBe(true);
    expect(criteria.some((c) => c.startsWith("CC9"))).toBe(true);
  });
});

describe("complianceSubprocessorsHandler", () => {
  it("returns non-empty subprocessors list", async () => {
    const response = complianceSubprocessorsHandler();
    const json = await response.json() as any;
    expect(json.data).toBeDefined();
    expect(json.data.subprocessors).toBeDefined();
    expect(json.data.subprocessors.length).toBeGreaterThan(0);
  });
});

describe("complianceSoc2MappingHandler", () => {
  it("returns mapping with CC entries", async () => {
    const response = complianceSoc2MappingHandler();
    const json = await response.json() as any;
    expect(json.data).toBeDefined();
    expect(json.data.mapping).toBeDefined();
    expect(json.data.mapping.length).toBeGreaterThan(0);
    const criteria = json.data.mapping.map((m: any) => m.criteria);
    expect(criteria.some((c: string) => c.startsWith("CC6"))).toBe(true);
  });
});

describe("complianceDpaHandler", () => {
  it("returns DPA document for tenant", async () => {
    const db = setupTestDb();
    const req = new Request("http://localhost/api/compliance/dpa");
    const response = complianceDpaHandler(req);
    expect(response.status).toBe(200);
    const json = await response.json() as any;
    expect(json.data).toBeDefined();
    expect(json.data.document).toContain("Data Processing Agreement");
    expect(json.data.document).not.toContain("{{CUSTOMER_NAME}}");
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });
});

describe("signed compliance evidence ZIP route", () => {
  it("rejects unauthenticated requests to all compliance GET routes", async () => {
    const routes = [
      "/api/compliance/dpa",
      "/api/compliance/subprocessors",
      "/api/compliance/soc2-mapping",
      "/api/compliance/summary",
      "/api/compliance/evidence-bundle",
      "/api/compliance/evidence-pack.zip",
    ];

    for (const route of routes) {
      const req = new Request(`http://localhost${route}`);
      const response = await handleApi(req, new URL(req.url));
      expect(response.status).toBe(401);
    }
  });

  it("returns 400 for garbage period parameters", async () => {
    const req = new Request("http://localhost/api/compliance/evidence-pack.zip?from=garbage&to=2000", {
      headers: { "x-operator-token": TEST_OPERATOR_TOKEN },
    });
    const response = await handleApi(req, new URL(req.url));
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns a non-empty application/zip body and audits the requested period", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "compliance-route-"));
    const previousDb = process.env.DASHBOARD_DB;
    const previousPath = process.env.DASHBOARD_DB_PATH;
    closeDashboardDb();
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });

    try {
      const req = new Request("http://localhost/api/compliance/evidence-pack.zip?from=10000&to=20000", {
        headers: { "x-operator-token": TEST_OPERATOR_TOKEN },
      });
      const response = await handleApi(req, new URL(req.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/zip");
      expect(response.headers.get("Content-Disposition")).toMatch(
        /^attachment; filename="evidence-pack-mimule-\d{4}-\d{2}-\d{2}\.zip"$/,
      );
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.length).toBeGreaterThan(0);

      const audit = getDashboardDb()!.query(`
        SELECT action_kind, risk, request_json
        FROM action_audit
        WHERE action_kind = 'compliance.evidence-pack'
        ORDER BY id DESC LIMIT 1
      `).get() as { action_kind: string; risk: string; request_json: string } | null;
      expect(audit).not.toBeNull();
      expect(audit!.risk).toBe("low");
      expect(JSON.parse(audit!.request_json)).toEqual({ period: { from: 10_000, to: 20_000 } });

      const keyRow = getDashboardDb()!.query(
        `SELECT value_json FROM operator_state WHERE key = 'evidence_signing_key'`,
      ).get() as { value_json: string };
      const keyHex = (JSON.parse(keyRow.value_json) as { keyHex: string }).keyHex;
      expect(body.toString("utf8")).not.toContain(keyHex);
    } finally {
      closeDashboardDb();
      if (previousDb === undefined) delete process.env.DASHBOARD_DB;
      else process.env.DASHBOARD_DB = previousDb;
      if (previousPath === undefined) delete process.env.DASHBOARD_DB_PATH;
      else process.env.DASHBOARD_DB_PATH = previousPath;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
