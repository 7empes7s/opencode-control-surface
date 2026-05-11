import { describe, test, expect, beforeEach } from "bun:test";
import { todayHandler } from "./today.ts";

describe("todayHandler", () => {
  beforeEach(() => {
    delete process.env.DASHBOARD_DB;
  });

  test("returns 200 with all required sections", async () => {
    const response = await todayHandler();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("date");
    expect(data).toHaveProperty("overnightSummary");
    expect(data).toHaveProperty("publishingSummary");
    expect(data).toHaveProperty("modelSummary");
    expect(data).toHaveProperty("infraSummary");
    expect(data).toHaveProperty("costSummary");
    expect(data).toHaveProperty("suggestedSchedule");
  });

  test("overnightSummary has expected fields", async () => {
    const response = await todayHandler();
    const data = await response.json();

    expect(data.overnightSummary).toHaveProperty("eventsCount");
    expect(data.overnightSummary).toHaveProperty("topEvents");
    expect(data.overnightSummary).toHaveProperty("newArticles");
    expect(data.overnightSummary).toHaveProperty("serviceRestarts");
    expect(Array.isArray(data.overnightSummary.topEvents)).toBe(true);
  });

  test("publishingSummary has expected fields", async () => {
    const response = await todayHandler();
    const data = await response.json();

    expect(data.publishingSummary).toHaveProperty("publishedToday");
    expect(data.publishingSummary).toHaveProperty("pendingApproval");
    expect(data.publishingSummary).toHaveProperty("failed");
    expect(data.publishingSummary).toHaveProperty("topCandidates");
    expect(Array.isArray(data.publishingSummary.topCandidates)).toBe(true);
  });

  test("modelSummary has expected fields", async () => {
    const response = await todayHandler();
    const data = await response.json();

    expect(data.modelSummary).toHaveProperty("bestAvailable");
    expect(data.modelSummary).toHaveProperty("degraded");
    expect(data.modelSummary).toHaveProperty("blocked");
    expect(data.modelSummary).toHaveProperty("newlyDiscovered");
    expect(Array.isArray(data.modelSummary.bestAvailable)).toBe(true);
    expect(Array.isArray(data.modelSummary.degraded)).toBe(true);
    expect(Array.isArray(data.modelSummary.blocked)).toBe(true);
    expect(Array.isArray(data.modelSummary.newlyDiscovered)).toBe(true);
  });

  test("infraSummary has expected fields", async () => {
    const response = await todayHandler();
    const data = await response.json();

    expect(data.infraSummary).toHaveProperty("gpuStatus");
    expect(data.infraSummary).toHaveProperty("vastRunwayHours");
    expect(data.infraSummary).toHaveProperty("serviceIssues");
    expect(data.infraSummary).toHaveProperty("recentRestarts");
    expect(Array.isArray(data.infraSummary.serviceIssues)).toBe(true);
    expect(Array.isArray(data.infraSummary.recentRestarts)).toBe(true);
  });

  test("costSummary has expected fields", async () => {
    const response = await todayHandler();
    const data = await response.json();

    expect(data.costSummary).toHaveProperty("vastBalanceUsd");
    expect(data.costSummary).toHaveProperty("estimatedDailyBurnUsd");
    expect(data.costSummary).toHaveProperty("projectedMonthlyUsd");
    expect(data.costSummary).toHaveProperty("note");
  });

  test("suggestedSchedule is a non-null array", async () => {
    const response = await todayHandler();
    const data = await response.json();

    expect(Array.isArray(data.suggestedSchedule)).toBe(true);
    expect(data.suggestedSchedule).not.toBeNull();
  });

  test("costSummary.note is a non-empty string", async () => {
    const response = await todayHandler();
    const data = await response.json();

    expect(typeof data.costSummary.note).toBe("string");
    expect(data.costSummary.note.length).toBeGreaterThan(0);
  });

  test("date is in YYYY-MM-DD format", async () => {
    const response = await todayHandler();
    const data = await response.json();

    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});