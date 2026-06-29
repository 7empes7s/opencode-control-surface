import { describe, expect, test } from "bun:test";
import { SAFE_AUTO_ACTIONS, isSafeAutoAction, riskTierFor } from "./autoapply.ts";

describe("insights auto-apply: risk tiering", () => {
  test("the safe allowlist is intentionally minimal and excludes mutating/customer-facing actions", () => {
    expect(SAFE_AUTO_ACTIONS.has("start-job:model-health:all")).toBe(true);
    expect(SAFE_AUTO_ACTIONS.has("start-job:infra:doctor-log-rotate")).toBe(true);
    // The dangerous ones must NEVER be auto-applied.
    expect(SAFE_AUTO_ACTIONS.has("start-job:service:newsbites")).toBe(false);
    expect(SAFE_AUTO_ACTIONS.has("start-job:service:vast-tunnel")).toBe(false);
    expect(SAFE_AUTO_ACTIONS.has("start-job:gateway:route-healthiest")).toBe(false);
    expect(SAFE_AUTO_ACTIONS.has("mutate-policy:model:x:block")).toBe(false);
    expect(SAFE_AUTO_ACTIONS.size).toBe(2);
  });

  test("isSafeAutoAction only matches the allowlist and cooldown-clear pattern", () => {
    expect(isSafeAutoAction("start-job:model-health:all")).toBe(true);
    expect(isSafeAutoAction("start-job:infra:doctor-log-rotate")).toBe(true);
    expect(isSafeAutoAction("mutate-policy:model:editorial-heavy:cooldown-clear")).toBe(true);
    expect(isSafeAutoAction("start-job:service:newsbites")).toBe(false);
    expect(isSafeAutoAction("mutate-policy:model:editorial-heavy:block")).toBe(false);
    expect(isSafeAutoAction(null)).toBe(false);
    expect(isSafeAutoAction(undefined)).toBe(false);
  });

  test("riskTierFor classifies findings", () => {
    expect(riskTierFor({ actionDescriptorId: "start-job:model-health:all" })).toBe("auto");
    expect(riskTierFor({ actionDescriptorId: "mutate-policy:model:editorial-heavy:cooldown-clear" })).toBe("auto");
    expect(riskTierFor({ actionDescriptorId: "start-job:service:vast-tunnel" })).toBe("review");
    expect(riskTierFor({ actionDescriptorId: null })).toBe("none");
  });
});
