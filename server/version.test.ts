import { describe, expect, it } from "bun:test";
import { VERSION, BUILD_COMMIT, BUILD_TIME, BUILD_HASH, getVersionInfo, type VersionInfo } from "./version.ts";

describe("version", () => {
  it("VERSION is a valid semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("VERSION is 1.0.0", () => {
    expect(VERSION).toBe("1.0.0");
  });

  it("getVersionInfo() returns all required fields", () => {
    const info = getVersionInfo();
    expect(typeof info.version).toBe("string");
    expect(typeof info.buildHash).toBe("string");
    expect(info.apiVersion).toBe("v1");
    expect(typeof info.commit).toBe("string");
    expect(typeof info.buildTime).toBe("string");
    expect(typeof info.nodeEnv).toBe("string");
    expect(typeof info.platform).toBe("string");
    expect(typeof info.arch).toBe("string");
  });

  it("VERSION matches the version in getVersionInfo()", () => {
    const info = getVersionInfo();
    expect(info.version).toBe(VERSION);
  });

  it("version field matches semver pattern", () => {
    const info = getVersionInfo();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("buildHash is a string (7-char hash or dev)", () => {
    const info = getVersionInfo();
    expect(info.buildHash).toMatch(/^[a-f0-9]{7}$|^dev$/);
  });

  it("apiVersion is v1", () => {
    const info = getVersionInfo();
    expect(info.apiVersion).toBe("v1");
  });

  it("platform and arch reflect the runtime environment", () => {
    const info = getVersionInfo();
    expect(["linux", "darwin", "win32"]).toContain(info.platform);
    expect(typeof info.arch).toBe("string");
  });
});