import { describe, test, expect, beforeEach } from "bun:test";
import { missionControlHandler } from "./missionControl.ts";

describe("missionControlHandler", () => {
  beforeEach(() => {
    // Reset env to ensure DASHBOARD_DB is not set (disabled by default)
    delete process.env.DASHBOARD_DB;
  });

  test("returns 200 with required fields", async () => {
    const response = await missionControlHandler();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("nowCard");
    expect(data).toHaveProperty("decisionQueue");
    expect(data).toHaveProperty("nextBestActions");
    expect(data).toHaveProperty("riskStrip");
  });

  test("nowCard has expected shape", async () => {
    const response = await missionControlHandler();
    const data = await response.json();

    expect(data.nowCard).toHaveProperty("posture");
    expect(["ok", "warn", "critical"]).toContain(data.nowCard.posture);
    expect(data.nowCard).toHaveProperty("summary");
    expect(typeof data.nowCard.summary).toBe("string");
    expect(data.nowCard).toHaveProperty("sources");
  });

  test("riskStrip always contains runway entry", async () => {
    const response = await missionControlHandler();
    const data = await response.json();

    const runwayEntry = data.riskStrip.find((r: { kind: string }) => r.kind === "runway");
    expect(runwayEntry).toBeDefined();
    expect(runwayEntry).toHaveProperty("severity");
    expect(["ok", "warn", "critical"]).toContain(runwayEntry.severity);
  });

  test("nextBestActions is an array", async () => {
    const response = await missionControlHandler();
    const data = await response.json();

    expect(Array.isArray(data.nextBestActions)).toBe(true);
  });

  test("decisionQueue is an array", async () => {
    const response = await missionControlHandler();
    const data = await response.json();

    expect(Array.isArray(data.decisionQueue)).toBe(true);
  });

  test("changeSinceLastVisit is null when DASHBOARD_DB is disabled", async () => {
    const response = await missionControlHandler();
    const data = await response.json();

    expect(data.changeSinceLastVisit).toBeNull();
  });

  test("riskStrip contains all required kinds", async () => {
    const response = await missionControlHandler();
    const data = await response.json();

    const requiredKinds = ["runway", "stale_telemetry", "failed_check", "incident", "queue"];
    const kinds = data.riskStrip.map((r: { kind: string }) => r.kind);

    for (const kind of requiredKinds) {
      expect(kinds).toContain(kind);
    }
  });
});