import { describe, expect, it } from "bun:test";
import { deriveGpuStatus } from "./home.ts";

describe("deriveGpuStatus (honest GPU state)", () => {
  it("reports up when the probe is fresh and healthy", () => {
    const result = deriveGpuStatus({ healthStatus: "up", healthFresh: true, instanceKnown: true, instanceStatus: "running" });
    expect(result.status).toBe("up");
    expect(result.note).toBeNull();
  });

  it("reports a real failure when the instance runs but the fresh probe fails", () => {
    const result = deriveGpuStatus({ healthStatus: "down", healthFresh: true, instanceKnown: true, instanceStatus: "running" });
    expect(result.status).toBe("down");
    expect(result.note).toContain("tunnel");
  });

  it("reports off (not down) when no Vast instance is rented, even with a stale down probe", () => {
    const result = deriveGpuStatus({ healthStatus: "down", healthFresh: false, instanceKnown: true, instanceStatus: null });
    expect(result.status).toBe("off");
    expect(result.note).toContain("off by operator");
  });

  it("reports off when the instance is stopped", () => {
    const result = deriveGpuStatus({ healthStatus: "down", healthFresh: true, instanceKnown: true, instanceStatus: "stopped" });
    expect(result.status).toBe("off");
    expect(result.note).toContain("stopped");
  });

  it("does NOT claim off when the vast CLI is unavailable — trusts a fresh down probe", () => {
    const result = deriveGpuStatus({ healthStatus: "down", healthFresh: true, instanceKnown: false, instanceStatus: null });
    expect(result.status).toBe("down");
  });

  it("reports unknown (never a fabricated up/down/off) when both probe and CLI are unavailable or stale", () => {
    const stale = deriveGpuStatus({ healthStatus: "down", healthFresh: false, instanceKnown: false, instanceStatus: null });
    expect(stale.status).toBe("unknown");
    expect(stale.note).toContain("stale");

    const missing = deriveGpuStatus({ healthStatus: null, healthFresh: false, instanceKnown: false, instanceStatus: null });
    expect(missing.status).toBe("unknown");
    expect(missing.note).toContain("No GPU probe data");
  });
});
