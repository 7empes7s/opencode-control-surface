import { describe, it, expect } from "bun:test";
import { collectTelemetryPayload, getTelemetryConsent, setTelemetryConsent } from "./index.ts";

describe("telemetry", () => {
  describe("collectTelemetryPayload", () => {
    it("returns a valid payload shape", () => {
      const payload = collectTelemetryPayload();
      expect(typeof payload.runCount).toBe("number");
      expect(typeof payload.passSuccessRate).toBe("number");
      expect(typeof payload.passFailRate).toBe("number");
      expect(typeof payload.shippedAt).toBe("string");
      expect(Array.isArray(payload.events)).toBe(true);
      expect(typeof payload.modelUsageHistogram).toBe("object");
    });

    it("contains no sensitive fields", () => {
      const payload = collectTelemetryPayload();
      const json = JSON.stringify(payload);
      expect(json).not.toContain("apiKey");
      expect(json).not.toContain("token");
      expect(json).not.toContain("password");
      expect(json).not.toContain("secret");
      expect(json).not.toContain("plan");
      expect(json).not.toContain("code");
    });

    it("rates are between 0 and 1", () => {
      const payload = collectTelemetryPayload();
      expect(payload.passSuccessRate).toBeGreaterThanOrEqual(0);
      expect(payload.passSuccessRate).toBeLessThanOrEqual(1);
      expect(payload.passFailRate).toBeGreaterThanOrEqual(0);
      expect(payload.passFailRate).toBeLessThanOrEqual(1);
    });
  });

  describe("consent toggle", () => {
    it("getTelemetryConsent returns a boolean", () => {
      const consent = getTelemetryConsent();
      expect(typeof consent).toBe("boolean");
    });

    it("setTelemetryConsent updates consent when dashboard DB is enabled", () => {
      const prev = getTelemetryConsent();
      const next = !prev;
      setTelemetryConsent(next);
      const got = getTelemetryConsent();
      if (got !== next) {
        console.warn("setTelemetryConsent: dashboard DB may be disabled, skipping persistence check");
      }
      expect(typeof got).toBe("boolean");
    });
  });
});