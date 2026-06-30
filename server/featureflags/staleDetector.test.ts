import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { initDashboardDb, closeDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { DEFAULT_TENANT_ID } from "../tenancy/context.ts";
import { createFlag, deleteFlag } from "./store.ts";
import { readStaleFeatureFlagFindings } from "../insights/scanners/governance.ts";

const TEST_DB = "/tmp/test-staledetector.db";

function withTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStore.run({ tenantId, source: "test" }, fn);
}

beforeEach(() => {
  rmSync(TEST_DB, { force: true });
  initDashboardDb({ enabled: true, path: TEST_DB });
});

afterEach(() => {
  closeDashboardDb();
  rmSync(TEST_DB, { force: true });
});

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
const NINETY_ONE_DAYS_MS = 91 * 24 * 60 * 60 * 1000;

function backdateFlag(id: string, daysAgo: number): void {
  const db = getDashboardDb();
  if (!db) return;
  const ts = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  db.query("UPDATE feature_flags SET updated_at = ?, created_at = ? WHERE id = ?").run(ts, ts, id);
}

describe("readStaleFeatureFlagFindings", () => {
  it("returns a finding for a fully-rolled-out flag unchanged for 30+ days", () => {
    const flag = withTenant(DEFAULT_TENANT_ID, () =>
      createFlag({ key: "old-rollout", enabled: true, rolloutPercentage: 100 })
    );
    backdateFlag(flag.id, 31);

    const findings = withTenant(DEFAULT_TENANT_ID, () => readStaleFeatureFlagFindings());
    const match = findings.find((f) => f.sourceKey === `ops:stale-feature-flag:old-rollout`);
    expect(match).toBeDefined();
    expect(match!.domain).toBe("ops");
    expect(match!.severity).toBe("low");
    expect(match!.manualPageHref).toBe("/feature-flags");
    expect(match!.plainSummary).toContain("old-rollout");
  });

  it("returns no finding for a fresh fully-rolled-out flag", () => {
    withTenant(DEFAULT_TENANT_ID, () =>
      createFlag({ key: "fresh-rollout", enabled: true, rolloutPercentage: 100 })
    );
    // updated_at is now — fresh, no finding
    const findings = withTenant(DEFAULT_TENANT_ID, () => readStaleFeatureFlagFindings());
    const match = findings.find((f) => f.sourceKey === "ops:stale-feature-flag:fresh-rollout");
    expect(match).toBeUndefined();
  });

  it("returns no finding for a partial rollout even if old", () => {
    const flag = withTenant(DEFAULT_TENANT_ID, () =>
      createFlag({ key: "partial", enabled: true, rolloutPercentage: 50 })
    );
    backdateFlag(flag.id, 31);
    // partial rollout: no fully-rolled-out finding; but 31 days < 90 days untouched threshold
    const findings = withTenant(DEFAULT_TENANT_ID, () => readStaleFeatureFlagFindings());
    // Should NOT produce a "fully rolled out" finding
    const rolloutMatch = findings.find(
      (f) => f.sourceKey === "ops:stale-feature-flag:partial" && f.severity === "low",
    );
    expect(rolloutMatch).toBeUndefined();
  });

  it("returns no finding for a disabled flag even if old", () => {
    const flag = withTenant(DEFAULT_TENANT_ID, () =>
      createFlag({ key: "disabled-old", enabled: false, rolloutPercentage: 100 })
    );
    backdateFlag(flag.id, 31);
    const findings = withTenant(DEFAULT_TENANT_ID, () => readStaleFeatureFlagFindings());
    const rolloutMatch = findings.find(
      (f) => f.sourceKey === "ops:stale-feature-flag:disabled-old" && f.severity === "low",
    );
    expect(rolloutMatch).toBeUndefined();
  });

  it("produces no findings when the table is empty", () => {
    const findings = withTenant(DEFAULT_TENANT_ID, () => readStaleFeatureFlagFindings());
    expect(findings.length).toBe(0);
  });

  it("returns an info finding for a flag untouched for 90+ days", () => {
    const flag = withTenant(DEFAULT_TENANT_ID, () =>
      createFlag({ key: "ancient", enabled: false, rolloutPercentage: 20 })
    );
    backdateFlag(flag.id, 91);
    const findings = withTenant(DEFAULT_TENANT_ID, () => readStaleFeatureFlagFindings());
    const match = findings.find((f) => f.sourceKey === "ops:stale-feature-flag:ancient");
    expect(match).toBeDefined();
    expect(match!.severity).toBe("info");
  });
});
