import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { testTenantContext } from "../tenancy/context.ts";
import { CONTROL_CATALOG, type ControlStatus } from "./controls.ts";
import {
  ISO_42001_ANNEX_A_REFERENCE_INDEX,
} from "./iso42001AnnexA.ts";
import {
  ISO_42001_ANNEX_A_REF_PREFIX,
  iso42001AnnexAClauseIds,
  listFrameworkMapping,
  rollupFrameworkStatus,
} from "./frameworkMapping.ts";

const NOW = 1_800_000_000_000;
const MAPPED_CLAUSE_IDS = ["A.4.1", "A.5.2", "A.5.3", "A.6.1", "A.6.2", "A.7.2", "A.7.4", "A.8.2"];

describe("ISO/IEC 42001 Annex A framework mapping", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "framework-mapping-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    expect(initDashboardDb({ path: process.env.DASHBOARD_DB_PATH })).not.toBeNull();
  });

  afterEach(() => {
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("keeps a unique static reference index and resolves every S9 ISO label", () => {
    const indexIds = ISO_42001_ANNEX_A_REFERENCE_INDEX.map((clause) => clause.id);
    expect(indexIds).toHaveLength(50);
    expect(new Set(indexIds).size).toBe(indexIds.length);

    const catalogClauseIds = CONTROL_CATALOG.flatMap((control) => iso42001AnnexAClauseIds(control.frameworkRefs));
    expect([...new Set(catalogClauseIds)].sort()).toEqual([...MAPPED_CLAUSE_IDS].sort());
    expect(catalogClauseIds.every((id) => indexIds.includes(id))).toBe(true);
    expect(CONTROL_CATALOG.flatMap((control) => control.frameworkRefs)
      .filter((reference) => reference.startsWith(ISO_42001_ANNEX_A_REF_PREFIX))).toHaveLength(16);
  });

  test("returns every direct mapping and the complete, non-inferred complement", () => {
    const result = listFrameworkMapping(NOW, testTenantContext());

    expect(result.coverage).toEqual({
      referenceClauseCount: 50,
      mappedClauseCount: 8,
      unmappedClauseCount: 42,
      mappedControlCount: 16,
    });
    expect(result.mappedClauses.map((mapping) => mapping.clause.id)).toEqual(MAPPED_CLAUSE_IDS);
    expect(result.mappedClauses.find((mapping) => mapping.clause.id === "A.6.2")?.controls.map((control) => control.id)).toEqual([
      "security-posture",
      "budget-guardrails",
      "edge-exposure",
      "model-route-truth",
    ]);
    expect(result.mappedClauses.every((mapping) => mapping.status === null)).toBe(true);
    expect(result.unmappedClauses.some((clause) => clause.id === "A.6.2.2")).toBe(true);
  });

  test("rolls up the worst stored status without inventing a status", () => {
    expect(rollupFrameworkStatus([])).toBeNull();
    expect(rollupFrameworkStatus([{ status: "pass" }, { status: null }])).toBe("pass");
    expect(rollupFrameworkStatus([{ status: "pass" }, { status: "not-covered" }])).toBe("not-covered");
    expect(rollupFrameworkStatus([{ status: "not-covered" }, { status: "fail" }])).toBe("fail");
    expect(rollupFrameworkStatus([{ status: "fail" }, { status: "error" }])).toBe("error");
  });

  test("uses only this tenant's latest S9 results and never writes", () => {
    const db = getDashboardDb()!;
    const insert = db.query(`
      INSERT INTO control_results
        (tenant_id, control_id, ts, status, findings_count, max_severity, evidence)
      VALUES (?, ?, ?, ?, 0, NULL, NULL)
    `);
    const addResult = (tenantId: string, controlId: string, status: ControlStatus, ts = NOW) => {
      insert.run(tenantId, controlId, ts, status);
    };

    addResult("mimule", "security-posture", "pass");
    addResult("mimule", "budget-guardrails", "fail");
    addResult("mimule", "edge-exposure", "pass");
    addResult("mimule", "model-route-truth", "error");
    addResult("mimule", "shadow-ai-discovery", "pass");
    addResult("mimule", "artifact-provenance-c2pa", "not-covered");
    addResult("mimule", "ai-provider-risk-register", "not-covered");
    addResult("other-tenant", "security-posture", "error", NOW + 10);

    const rowCountBefore = Number((db.query("SELECT COUNT(*) AS count FROM control_results").get() as { count: number }).count);
    const defaultTenant = listFrameworkMapping(NOW + 20, testTenantContext());
    const otherTenant = listFrameworkMapping(NOW + 20, testTenantContext({ tenantId: "other-tenant" }));
    const rowCountAfter = Number((db.query("SELECT COUNT(*) AS count FROM control_results").get() as { count: number }).count);

    expect(defaultTenant.mappedClauses.find((mapping) => mapping.clause.id === "A.6.2")?.status).toBe("error");
    expect(defaultTenant.mappedClauses.find((mapping) => mapping.clause.id === "A.6.1")?.status).toBe("not-covered");
    expect(otherTenant.mappedClauses.find((mapping) => mapping.clause.id === "A.6.2")?.status).toBe("error");
    expect(rowCountAfter).toBe(rowCountBefore);
  });

  test("is null-DB safe and retains the honest mapped/unmapped topology", () => {
    closeDashboardDb();

    const result = listFrameworkMapping(NOW, testTenantContext());
    expect(result.mappedClauses).toHaveLength(8);
    expect(result.unmappedClauses).toHaveLength(42);
    expect(result.mappedClauses.every((mapping) => mapping.status === null)).toBe(true);
  });
});
