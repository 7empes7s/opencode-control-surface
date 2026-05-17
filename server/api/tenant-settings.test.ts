import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { getDashboardDb, initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";
import { getTenantSettings, updateTenantSettings } from "../tenancy/settings.ts";

const TEST_DB = "/tmp/test-tenant-settings-control-surface.db";

function setupTestDb() {
  rmSync(TEST_DB, { force: true });
  closeDashboardDb();
  return initDashboardDb({ enabled: true, path: TEST_DB })!;
}

describe("getTenantSettings", () => {
  let db: ReturnType<typeof setupTestDb>;

  beforeEach(() => {
    db = setupTestDb();
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });

  it("returns default settings with auditRetentionDays=90", () => {
    const settings = getTenantSettings("test-tenant");
    expect(settings.auditRetentionDays).toBe(90);
    expect(settings.dataResidencyRegion).toBe("auto");
    expect(settings.storageRoot).toContain("test-tenant");
  });

  it("returns stored settings from DB", () => {
    const now = Date.now();
    db.query(
      `INSERT INTO tenant_settings (tenant_id, audit_retention_days, data_residency_region, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("test-tenant", 30, "eu-west", now);

    const settings = getTenantSettings("test-tenant");
    expect(settings.auditRetentionDays).toBe(30);
    expect(settings.dataResidencyRegion).toBe("eu-west");
  });
});

describe("updateTenantSettings", () => {
  let db: ReturnType<typeof setupTestDb>;

  beforeEach(() => {
    db = setupTestDb();
  });

  afterEach(() => {
    closeDashboardDb();
    rmSync(TEST_DB, { force: true });
  });

  it("updates dataResidencyRegion", () => {
    const updated = updateTenantSettings("test-tenant", {
      dataResidencyRegion: "us-east",
    });
    expect(updated.dataResidencyRegion).toBe("us-east");
  });

  it("updates storageRoot correctly", () => {
    const updated = updateTenantSettings("test-tenant", {
      storageRoot: "/custom/storage",
    });
    expect(updated.storageRoot).toBe("/custom/storage");
  });
});