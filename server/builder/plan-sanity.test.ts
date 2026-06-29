import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeBuilderPlanSanity, getPlanSanityStartBlockers } from "./plan-sanity.ts";

function withPlan(contents: string, fn: (path: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "builder-plan-sanity-"));
  try {
    const path = join(root, "PLAN.md");
    writeFileSync(path, contents, "utf8");
    fn(path, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("builder plan sanity checker", () => {
  test("blocks plan items that require unavailable external mobile services", () => withPlan(`
- [ ] Submit TestFlight build through EAS.
- [ ] Verify Google Play Billing sandbox purchase.
- [ ] Run the flow in a real iOS simulator.
`, (path) => {
    const blockers = getPlanSanityStartBlockers(path, {
      env: {},
      platform: "linux",
      commandExists: () => false,
    });

    expect(blockers.some((item) => item.includes("external-apple-credentials-unavailable"))).toBe(true);
    expect(blockers.some((item) => item.includes("external-google-play-unavailable"))).toBe(true);
    expect(blockers.some((item) => item.includes("external-ios-simulator-unavailable"))).toBe(true);
  }));

  test("does not block external mobile items when required capabilities are present", () => withPlan(`
- [ ] Submit TestFlight build through EAS.
- [ ] Verify Google Play Billing sandbox purchase.
- [ ] Run the flow in a real iOS simulator.
`, (path, root) => {
    const googleCreds = join(root, "google.json");
    writeFileSync(googleCreds, "{}", "utf8");

    const result = analyzeBuilderPlanSanity(path, {
      env: { EAS_TOKEN: "token", GOOGLE_APPLICATION_CREDENTIALS: googleCreds },
      platform: "darwin",
      commandExists: (command) => command === "xcrun",
    });

    expect(result.status).toBe("ok");
    expect(result.issues).toHaveLength(0);
  }));

  test("flags release items that precede validation prerequisites", () => withPlan(`
- [ ] Deploy the app to production.
- [ ] Repair the build baseline.
- [ ] Run validation smoke tests.
`, (path) => {
    const result = analyzeBuilderPlanSanity(path);

    expect(result.status).toBe("blocked");
    expect(result.issues.some((item) => item.code === "release-before-validation")).toBe(true);
  }));
});
