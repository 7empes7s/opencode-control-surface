import { describe, expect, it, afterEach } from "bun:test";
import { setCachedUpdateInfo, getCachedUpdateInfo } from "./updater.ts";

describe("updater", () => {
  afterEach(() => {
    setCachedUpdateInfo(null);
  });

  it("getCachedUpdateInfo returns null by default", () => {
    expect(getCachedUpdateInfo()).toBeNull();
  });

  it("getCachedUpdateInfo returns cached value after setCachedUpdateInfo", () => {
    const fake = { latestVersion: "1.0.0", releaseUrl: "http://x", changelog: "x" };
    setCachedUpdateInfo(fake);
    expect(getCachedUpdateInfo()).toEqual(fake);
  });
});