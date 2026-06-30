import { describe, expect, test } from "bun:test";
import { lookupInsightRunbook } from "./runbooks.ts";

describe("lookupInsightRunbook", () => {
  test("returns a specific runbook for a known detector/action family", () => {
    const row = lookupInsightRunbook({
      domain: "ops",
      actionDescriptorId: "mutate-policy:model:editorial-fast:cooldown-clear",
      sourceKey: "ops:cooldown-stuck:editorial-fast",
    });

    expect(row.key).toBe("mutate-policy:model:*:cooldown-clear");
    expect(row.what).toContain("cooldown");
    expect(row.apply).toContain("removes");
    expect(row.revert).toContain("block");
  });

  test("unknown kinds return the honest generic fallback", () => {
    const row = lookupInsightRunbook({
      domain: "data",
      actionDescriptorId: "unknown-action:thing:123",
      sourceKey: "unknown:detector:123",
    });

    expect(row.key).toBe("generic");
    expect(row.what).toContain("no detector-specific runbook");
    expect(row.apply).toContain("exact action descriptor");
    expect(row.revert).toContain("audit row");
  });
});
