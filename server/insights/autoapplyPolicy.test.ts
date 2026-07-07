import { describe, expect, test } from "bun:test";
import { defaultTierForAction } from "./autoapplyPolicy.ts";

// SPEC 16 (ULTRAPLAN P3/A4a+A4b): probe:model:* must stay at review tier until
// the auto-promotion gate (docs/AUTOAPPLY_PROMOTION_REVIEW.md entry + operator
// sign-off) clears. clear-cooldown:model:* is the already-promoted (2026-07-05)
// rename of mutate-policy:model:*:cooldown-clear and must remain auto.
describe("defaultTierForAction — probe:model vs clear-cooldown:model", () => {
  test("probe:model:<logicalName> defaults to review tier (not yet gated for auto)", () => {
    expect(defaultTierForAction("probe:model:editorial-heavy")).toBe("review");
  });

  test("clear-cooldown:model:<name> stays at auto tier (already-promoted family)", () => {
    expect(defaultTierForAction("clear-cooldown:model:editorial-heavy")).toBe("auto");
  });
});
