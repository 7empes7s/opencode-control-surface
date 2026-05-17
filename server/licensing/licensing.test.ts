import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import {
  verifyLicense,
  getActiveLicense,
  isFeatureEnabled,
  generateLicenseKey,
} from "./index.ts";

describe("licensing", () => {
  const testDir = join("/tmp", "builder-licensing-test-" + Date.now());
  const testKeyPath = join(testDir, "license.key");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testKeyPath)) unlinkSync(testKeyPath);
    if (existsSync(testDir)) {
      try {
        unlinkSync(join(testDir, "license.key"));
      } catch { /* ignore */ }
    }
  });

  describe("verifyLicense", () => {
    it("returns solo status when no license file exists", () => {
      const result = verifyLicense("/nonexistent/path/license.key");
      expect(result.tier).toBe("solo");
      expect(result.licensed).toBe(false);
      expect(result.features).toEqual([]);
    });

    it("returns solo status for malformed JSON", () => {
      writeFileSync(testKeyPath, "not valid json", "utf-8");
      const result = verifyLicense(testKeyPath);
      expect(result.tier).toBe("solo");
    });

    it("returns solo status when signature is invalid", () => {
      const license = {
        tier: "team",
        tenantId: "tenant-123",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        features: ["sso"],
        signature: "invalid-signature",
      };
      writeFileSync(testKeyPath, JSON.stringify(license), "utf-8");
      const result = verifyLicense(testKeyPath);
      expect(result.tier).toBe("solo");
    });

    it("returns solo status when license is expired", () => {
      const secret = "test-secret-456";
      const license = {
        tier: "enterprise",
        tenantId: "tenant-123",
        issuedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        expiresAt: new Date(Date.now() - 86400000).toISOString(),
        features: ["sso", "audit-export"],
        signature: "",
      };
      const payload = JSON.stringify({
        tier: license.tier,
        tenantId: license.tenantId,
        issuedAt: license.issuedAt,
        expiresAt: license.expiresAt,
        features: license.features,
      });
      license.signature = createHmac("sha256", secret).update(payload).digest("hex");
      writeFileSync(testKeyPath, JSON.stringify(license), "utf-8");
      const result = verifyLicense(testKeyPath);
      expect(result.tier).toBe("solo");
    });
  });

  describe("generateLicenseKey", () => {
    it("throws for solo tier", () => {
      expect(() => generateLicenseKey("solo", "tenant-1", "secret")).toThrow();
    });

    it("returns valid signed JSON for team tier", () => {
      const key = generateLicenseKey("team", "tenant-team-1", "shared-secret");
      const parsed = JSON.parse(key);
      expect(parsed.tier).toBe("team");
      expect(parsed.tenantId).toBe("tenant-team-1");
      expect(parsed.features).toContain("sso");
      expect(parsed.signature).toBeTruthy();
    });

    it("returns valid signed JSON for enterprise tier", () => {
      const key = generateLicenseKey("enterprise", "tenant-ent-1", "ent-secret");
      const parsed = JSON.parse(key);
      expect(parsed.tier).toBe("enterprise");
      expect(parsed.tenantId).toBe("tenant-ent-1");
      expect(parsed.signature).toBeTruthy();
    });
  });

  describe("isFeatureEnabled", () => {
    it("solo tier enables no paid features", () => {
      expect(isFeatureEnabled("sso")).toBe(false);
      expect(isFeatureEnabled("audit-export")).toBe(false);
      expect(isFeatureEnabled("cloud-tier")).toBe(false);
    });
  });
});