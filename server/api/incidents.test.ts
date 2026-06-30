import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { upsertInsight } from "../insights/store.ts";
import { buildIncidentsDetail } from "./incidents.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "incidents-api-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function insight(id: string, domain: "ops" | "security" | "build" | "cost", severity: "medium" | "high" | "critical") {
  upsertInsight({
    id,
    sourceKey: `${domain}:${id}`,
    domain,
    severity,
    title: `${domain} ${severity}`,
    plainSummary: "A seeded finding for incident saved-view tests.",
    confidence: 0.8,
    evidenceRefs: [],
    actionDescriptorId: null,
    manualPageHref: `/${domain}`,
    createdAt: Date.now(),
  });
}

describe("incidents saved view", () => {
  test("reflects high-severity ops, security, and build insights", () => {
    insight("ops-down", "ops", "critical");
    insight("security-gap", "security", "high");
    insight("build-failure", "build", "high");
    insight("cost-warning", "cost", "critical");
    insight("ops-medium", "ops", "medium");

    const detail = buildIncidentsDetail();
    expect(detail.entries.map((entry) => entry.sourceKey).sort()).toEqual([
      "build:build-failure",
      "ops:ops-down",
      "security:security-gap",
    ]);
    expect(detail.entries.every((entry) => entry.detectionsHref?.startsWith("/insights?focus="))).toBe(true);
    expect(detail.stats.total).toBe(3);
  });

  test("is empty when no incident-grade insights exist", () => {
    insight("build-medium", "build", "medium");

    const detail = buildIncidentsDetail();
    expect(detail.entries).toEqual([]);
    expect(detail.stats.total).toBe(0);
  });
});
