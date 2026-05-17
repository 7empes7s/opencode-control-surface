import { describe, expect, it } from "bun:test";
import { generateDpa, listSubprocessors, getSoc2Mapping } from "../compliance/generator.ts";
import { initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";
import { complianceDpaHandler, complianceSubprocessorsHandler, complianceSoc2MappingHandler, complianceSummaryHandler } from "./compliance.ts";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/test-compliance-control-surface.db";

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