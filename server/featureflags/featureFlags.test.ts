import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { initDashboardDb, closeDashboardDb } from "../db/dashboard.ts";
import { tenantStore } from "../tenancy/middleware.ts";
import { DEFAULT_TENANT_ID } from "../tenancy/context.ts";
import {
  listFlags,
  getFlag,
  createFlag,
  updateFlag,
  toggleFlag,
  deleteFlag,
  getFlagHistory,
  evaluateFlag,
  stableHash,
  type FeatureFlag,
} from "./store.ts";

const TEST_DB = "/tmp/test-featureflags.db";

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

describe("feature flag store", () => {
  it("creates a flag and retrieves it", () => {
    withTenant(DEFAULT_TENANT_ID, () => {
      const flag = createFlag({ key: "my-flag", label: "My Flag", enabled: false, rolloutPercentage: 0 });
      expect(flag.id).toBeTruthy();
      expect(flag.key).toBe("my-flag");
      expect(flag.enabled).toBe(false);
      expect(flag.rolloutPercentage).toBe(0);
      expect(flag.tenantId).toBe(DEFAULT_TENANT_ID);

      const fetched = getFlag(flag.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.key).toBe("my-flag");
    });
  });

  it("lists only own-tenant flags", () => {
    withTenant("t1", () => createFlag({ key: "flag-t1" }));
    withTenant("t2", () => createFlag({ key: "flag-t2" }));

    const t1flags = withTenant("t1", () => listFlags());
    expect(t1flags.length).toBe(1);
    expect(t1flags[0].key).toBe("flag-t1");

    const t2flags = withTenant("t2", () => listFlags());
    expect(t2flags.length).toBe(1);
    expect(t2flags[0].key).toBe("flag-t2");
  });

  it("toggle persists enabled state and writes history", () => {
    withTenant(DEFAULT_TENANT_ID, () => {
      const flag = createFlag({ key: "toggle-me", enabled: false });
      const toggled = toggleFlag(flag.id, true, "tester");
      expect(toggled!.enabled).toBe(true);

      const history = getFlagHistory(flag.id);
      // created + toggled = 2 entries
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0].changedBy).toBe("tester");
      expect(history[0].note).toBe("enabled");
    });
  });

  it("update changes fields and writes history", () => {
    withTenant(DEFAULT_TENANT_ID, () => {
      const flag = createFlag({ key: "update-me", label: "Old" });
      const updated = updateFlag(flag.id, { label: "New", rolloutPercentage: 50 }, "tester");
      expect(updated!.label).toBe("New");
      expect(updated!.rolloutPercentage).toBe(50);

      const history = getFlagHistory(flag.id);
      expect(history.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("delete removes the flag and writes history", () => {
    withTenant(DEFAULT_TENANT_ID, () => {
      const flag = createFlag({ key: "delete-me" });
      const ok = deleteFlag(flag.id, "tester");
      expect(ok).toBe(true);
      expect(getFlag(flag.id)).toBeNull();

      const history = getFlagHistory(flag.id);
      expect(history.some((h) => h.note === "deleted")).toBe(true);
    });
  });

  it("unknown tenant cannot see another tenant's flags", () => {
    withTenant("t1", () => createFlag({ key: "private" }));
    const found = withTenant("t2", () => listFlags());
    expect(found.length).toBe(0);
  });

  it("getFlag returns null for another tenant's flag", () => {
    const flag = withTenant("t1", () => createFlag({ key: "secret" }));
    const result = withTenant("t2", () => getFlag(flag.id));
    expect(result).toBeNull();
  });
});

describe("evaluateFlag", () => {
  const base: FeatureFlag = {
    id: "f1",
    key: "test",
    label: null,
    description: null,
    enabled: true,
    rolloutPercentage: 50,
    targetingJson: null,
    createdAt: 0,
    updatedAt: 0,
    createdBy: null,
    tenantId: DEFAULT_TENANT_ID,
  };

  it("returns false when disabled", () => {
    expect(evaluateFlag({ ...base, enabled: false }, { key: "user-1" })).toBe(false);
  });

  it("returns false when rollout is 0", () => {
    expect(evaluateFlag({ ...base, rolloutPercentage: 0 }, { key: "user-1" })).toBe(false);
  });

  it("returns true when rollout is 100 and enabled", () => {
    expect(evaluateFlag({ ...base, rolloutPercentage: 100 }, { key: "user-1" })).toBe(true);
  });

  it("is deterministic: same key always gives same result", () => {
    const flag = { ...base, rolloutPercentage: 50 };
    const r1 = evaluateFlag(flag, { key: "stable-user" });
    const r2 = evaluateFlag(flag, { key: "stable-user" });
    expect(r1).toBe(r2);
  });

  it("is monotonic: raising percentage never flips included users out", () => {
    // Every user included at pct N should still be included at pct N+1.
    // We test for several users and a range of percentages.
    const users = Array.from({ length: 100 }, (_, i) => `user-${i}`);
    for (let pct = 0; pct < 99; pct++) {
      const flag50 = { ...base, rolloutPercentage: pct };
      const flag51 = { ...base, rolloutPercentage: pct + 1 };
      for (const u of users) {
        if (evaluateFlag(flag50, { key: u })) {
          expect(evaluateFlag(flag51, { key: u })).toBe(true);
        }
      }
    }
  });

  it("stableHash is non-negative and consistent", () => {
    expect(stableHash("hello")).toBeGreaterThanOrEqual(0);
    expect(stableHash("hello")).toBe(stableHash("hello"));
    expect(stableHash("a")).not.toBe(stableHash("b"));
  });
});
