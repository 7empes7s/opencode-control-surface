import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import {
  CONTROL_CATALOG,
  CONTROL_HISTORY_MAX_LIMIT,
  CONTROL_RESULT_HEARTBEAT_MS,
  CONTROL_RESULT_RETENTION_MS,
  evaluateControlTick,
  listControlHistory,
  normalizeControlHistoryLimit,
  recordControlsTick,
  SCANNER_KEYS,
  type ControlDefinition,
  type ControlTickSummary,
  type ScannerKey,
  type TickScannerSummary,
} from "./controls.ts";

const NOW = 1_800_000_000_000;

function summary(overrides: Partial<Record<ScannerKey, Partial<TickScannerSummary>>> = {}): ControlTickSummary {
  const tick = Object.fromEntries(
    SCANNER_KEYS.map((key) => [key, {
      ran: true,
      error: false,
      findingsCount: 0,
      maxSeverity: null,
    }]),
  ) as ControlTickSummary;

  for (const key of SCANNER_KEYS) {
    if (overrides[key]) tick[key] = { ...tick[key], ...overrides[key] };
  }
  return tick;
}

function scannerControl(scanner: ScannerKey): ControlDefinition {
  const control = CONTROL_CATALOG.find((item) => item.binding.kind === "scanner" && item.binding.scanner === scanner);
  if (!control) throw new Error(`Missing ${scanner} control`);
  return control;
}

describe("evaluateControlTick", () => {
  const modelRouteControl = scannerControl("modelRoutes");

  test("binds each scheduler scanner once and keeps declared gaps verbatim", () => {
    expect(CONTROL_CATALOG.flatMap((control) => (
      control.binding.kind === "scanner" ? [control.binding.scanner] : []
    ))).toEqual([...SCANNER_KEYS]);
    expect(CONTROL_CATALOG.filter((control) => control.binding.kind === "not-covered").map((control) => ({
      id: control.id,
      reason: control.binding.kind === "not-covered" ? control.binding.reason : "",
    }))).toEqual([
      { id: "artifact-provenance-c2pa", reason: "C2PA manifests inside generated artifacts are not verified" },
      { id: "agent-identity-review", reason: "Agent declarations are reviewable, but no periodic automated review control runs yet" },
      { id: "ai-provider-risk-register", reason: "No vendor risk register for AI providers" },
      { id: "external-saas-ai", reason: "SaaS-layer AI (S-X) is declared out of scope; no coverage claimed" },
    ]);
  });

  for (const scenario of [
    {
      label: "keeps a medium finding as a warning below a high failure threshold",
      tick: summary({ modelRoutes: { findingsCount: 1, maxSeverity: "medium" } }),
      expected: { ts: NOW, status: "pass", findingsCount: 1, maxSeverity: "medium", warnings: 1 },
    },
    {
      label: "fails when a finding reaches the high failure threshold",
      tick: summary({ modelRoutes: { findingsCount: 1, maxSeverity: "high" } }),
      expected: { ts: NOW, status: "fail", findingsCount: 1, maxSeverity: "high", warnings: 0 },
    },
  ] as const) {
    test(scenario.label, () => {
      expect(evaluateControlTick([modelRouteControl], scenario.tick, NOW)).toEqual([
        { controlId: "model-route-truth", ...scenario.expected },
      ]);
    });
  }

  test("records a scanner exception as an error result", () => {
    const results = evaluateControlTick(
      [modelRouteControl],
      summary({ modelRoutes: { ran: false, error: true } }),
      NOW,
    );
    expect(results).toEqual([{
      controlId: "model-route-truth",
      ts: NOW,
      status: "error",
      findingsCount: 0,
      maxSeverity: null,
      warnings: 0,
    }]);
  });

  test("does not create a result for a scanner skipped from this tick", () => {
    const tick = summary();
    delete (tick as Partial<ControlTickSummary>).modelRoutes;
    expect(evaluateControlTick([modelRouteControl], tick, NOW)).toEqual([]);
  });

  test("always emits the declared not-covered controls", () => {
    const results = evaluateControlTick(CONTROL_CATALOG, summary(), NOW);
    expect(results.filter((result) => result.status === "not-covered").map((result) => result.controlId)).toEqual([
      "artifact-provenance-c2pa",
      "agent-identity-review",
      "ai-provider-risk-register",
      "external-saas-ai",
    ]);
  });
});

describe("control result history", () => {
  let tempDir: string;
  let previousDashboardDb: string | undefined;
  let previousDashboardDbPath: string | undefined;

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "control-results-"));
    previousDashboardDb = process.env.DASHBOARD_DB;
    previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    expect(initDashboardDb({ path: process.env.DASHBOARD_DB_PATH })).not.toBeNull();
  });

  afterEach(() => {
    closeDashboardDb();
    if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = previousDashboardDb;
    if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("deduplicates identical results, writes changes, and writes an hourly heartbeat", () => {
    const first = summary({ modelRoutes: { findingsCount: 1, maxSeverity: "high" } });
    recordControlsTick(first, NOW);
    recordControlsTick(first, NOW + 1);

    const db = getDashboardDb()!;
    const count = () => Number((db.query(
      "SELECT COUNT(*) AS count FROM control_results WHERE control_id = 'model-route-truth'",
    ).get() as { count: number }).count);
    expect(count()).toBe(1);

    const changed = summary({ modelRoutes: { findingsCount: 2, maxSeverity: "high" } });
    recordControlsTick(changed, NOW + 2);
    expect(count()).toBe(2);

    recordControlsTick(changed, NOW + 2 + CONTROL_RESULT_HEARTBEAT_MS);
    expect(count()).toBe(3);
  });

  test("prunes results older than the 90-day retention period when writing", () => {
    const db = getDashboardDb()!;
    db.query(`
      INSERT INTO control_results
        (tenant_id, control_id, ts, status, findings_count, max_severity, evidence)
      VALUES ('mimule', 'security-posture', ?, 'pass', 0, NULL, NULL)
    `).run(NOW - CONTROL_RESULT_RETENTION_MS - 1);

    recordControlsTick(summary(), NOW);
    const oldRow = db.query("SELECT id FROM control_results WHERE ts < ?").get(NOW - CONTROL_RESULT_RETENTION_MS) as { id: number } | null;
    expect(oldRow).toBeNull();
  });

  test("clamps history reads to 500 rows", () => {
    const db = getDashboardDb()!;
    const insert = db.query(`
      INSERT INTO control_results
        (tenant_id, control_id, ts, status, findings_count, max_severity, evidence)
      VALUES ('mimule', 'security-posture', ?, 'pass', 0, NULL, NULL)
    `);
    for (let index = 0; index < CONTROL_HISTORY_MAX_LIMIT + 5; index += 1) {
      insert.run(NOW + index);
    }

    expect(normalizeControlHistoryLimit(null)).toBe(100);
    expect(normalizeControlHistoryLimit(10_000)).toBe(CONTROL_HISTORY_MAX_LIMIT);
    expect(listControlHistory("security-posture", 10_000)).toHaveLength(CONTROL_HISTORY_MAX_LIMIT);
  });
});
