import { describe, it, expect } from "bun:test";
import { onboardingStatusHandler } from "./onboarding.ts";

describe("onboarding", () => {
  describe("GET /api/onboarding/status", () => {
    it("returns a valid status shape", async () => {
      const response = onboardingStatusHandler();
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(typeof body.completed).toBe("boolean");
      expect(typeof body.currentStep).toBe("number");
      expect(typeof body.hostInfo).toBe("object");
      expect(typeof body.hostInfo.os).toBe("string");
      expect(Array.isArray(body.hostInfo.agents)).toBe(true);
      expect(typeof body.hostInfo.modelCount).toBe("number");
    });
  });
});