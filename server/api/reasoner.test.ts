import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantStore } from "../tenancy/middleware.ts";
import { testTenantContext } from "../tenancy/context.ts";
import {
  reasonerJobsHandler,
  reasonerDiagnosesHandler,
  reasonerIncidentsHandler,
  reasonerLoopStatsHandler,
} from "./reasoner.ts";
import { queueDiagnosis } from "../reasoner/agent.ts";
import { getDashboardDb } from "../db/dashboard.ts";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";

function withTenant<R>(tenantId: string, fn: () => R): R {
  return tenantStore.run(testTenantContext({ tenantId, source: "header" }), fn);
}

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "reasoner-api-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function insertDiagnosis(tenantId: string, passId: string, runId: string, workflowId: string) {
  const db = getDashboardDb();
  if (!db) throw new Error("db not available");
  db.query(`
    INSERT INTO reasoner_diagnoses
      (id, pass_id, run_id, workflow_id, failure_class, root_cause, evidence_json,
       suggested_actions_json, confidence, raw_llm_response, diagnosed_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `rd_${passId}`,
    passId,
    runId,
    workflowId,
    "timeout",
    "root-cause",
    "{}",
    "[]",
    "high",
    "response",
    Date.now(),
    tenantId,
  );
}

function insertIncident(tenantId: string, id: string, title: string) {
  const db = getDashboardDb();
  if (!db) throw new Error("db not available");
  db.query(`
    INSERT INTO reasoner_incidents
      (id, cluster_key, failure_class, title, first_seen, last_seen,
       occurrence_count, representative_pass_id, representative_diagnosis_id, status, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `ck_${id}`,
    "timeout",
    title,
    Date.now(),
    Date.now(),
    1,
    `rp_${id}`,
    `rd_${id}`,
    "open",
    tenantId,
  );
}

describe("reasoner API tenant isolation", () => {
  test("jobs list only returns current tenant jobs", async () => {
    withTenant("tenant-a", () => {
      queueDiagnosis("pass-a", "run-a", "wf-a");
    });
    withTenant("tenant-b", () => {
      queueDiagnosis("pass-b", "run-b", "wf-b");
    });

    const resA = await withTenant("tenant-a", () => reasonerJobsHandler());
    expect(resA.status).toBe(200);
    const { data: bodyA } = await resA.json() as { data: Array<{ workflowId: string }> };
    expect(bodyA.length).toBe(1);
    expect(bodyA[0].workflowId).toBe("wf-a");

    const resB = await withTenant("tenant-b", () => reasonerJobsHandler());
    expect(resB.status).toBe(200);
    const { data: bodyB } = await resB.json() as { data: Array<{ workflowId: string }> };
    expect(bodyB.length).toBe(1);
    expect(bodyB[0].workflowId).toBe("wf-b");
  });

  test("diagnoses list only returns current tenant diagnoses", async () => {
    insertDiagnosis("tenant-a", "pass-a", "run-a", "wf-a");
    insertDiagnosis("tenant-b", "pass-b", "run-b", "wf-b");

    const resA = await withTenant("tenant-a", () => reasonerDiagnosesHandler());
    expect(resA.status).toBe(200);
    const { data: bodyA } = await resA.json() as { data: Array<{ workflowId: string }> };
    expect(bodyA.length).toBe(1);
    expect(bodyA[0].workflowId).toBe("wf-a");

    const resB = await withTenant("tenant-b", () => reasonerDiagnosesHandler());
    expect(resB.status).toBe(200);
    const { data: bodyB } = await resB.json() as { data: Array<{ workflowId: string }> };
    expect(bodyB.length).toBe(1);
    expect(bodyB[0].workflowId).toBe("wf-b");
  });

  test("incidents list only returns current tenant incidents", async () => {
    insertIncident("tenant-a", "inc-a", "Incident A");
    insertIncident("tenant-b", "inc-b", "Incident B");

    const resA = await withTenant("tenant-a", () => reasonerIncidentsHandler());
    expect(resA.status).toBe(200);
    const { data: bodyA } = await resA.json() as { data: Array<{ title: string }> };
    expect(bodyA.length).toBe(1);
    expect(bodyA[0].title).toBe("Incident A");

    const resB = await withTenant("tenant-b", () => reasonerIncidentsHandler());
    expect(resB.status).toBe(200);
    const { data: bodyB } = await resB.json() as { data: Array<{ title: string }> };
    expect(bodyB.length).toBe(1);
    expect(bodyB[0].title).toBe("Incident B");
  });
});

describe("reasonerLoopStatsHandler mean_ttr_ms windowing (task #23 / ULTRAPLAN rider)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function insertResolved(tenantId: string, id: string, firstSeen: number, resolvedAt: number) {
    const db = getDashboardDb();
    if (!db) throw new Error("db not available");
    db.query(`
      INSERT INTO reasoner_incidents
        (id, cluster_key, failure_class, title, first_seen, last_seen,
         occurrence_count, representative_pass_id, representative_diagnosis_id, status, resolved_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'resolved', ?, ?)
    `).run(id, `ck_${id}`, "timeout", `title-${id}`, firstSeen, firstSeen, `rp_${id}`, `rd_${id}`, resolvedAt, tenantId);
  }

  test("resolved_at outside the trailing 7d window is excluded from mean_ttr_ms, and the window is reported", async () => {
    const now = Date.now();
    // Ancient row: first_seen years ago AND resolved_at itself outside the
    // 7d loop window — must not count toward mean_ttr_ms or resolved7d.
    insertResolved("tenant-loop", "ri_ancient", now - 900 * DAY_MS, now - 30 * DAY_MS);
    // Recent row, born and resolved well inside the window: 9,000ms duration.
    insertResolved("tenant-loop", "ri_recent", now - 10_000, now - 1_000);

    const res = await withTenant("tenant-loop", () => reasonerLoopStatsHandler());
    expect(res.status).toBe(200);
    const { data } = await res.json() as {
      data: { resolved7d: number; meanTimeToResolveMs: number | null; mttrWindowMs: number };
    };

    expect(data.resolved7d).toBe(1);
    expect(data.meanTimeToResolveMs).toBe(9_000);
    expect(data.mttrWindowMs).toBe(7 * DAY_MS);
  });

  test("a row born 2 years ago but resolved yesterday is excluded from mean_ttr_ms yet still counted in resolved7d", async () => {
    const now = Date.now();
    // THE live-DB bug scenario: 2023-era incident mass-closed this week.
    // resolved_at is inside the 7d window (so it IS a real close for
    // resolved7d/autoShare), but its multi-year duration must not enter the
    // 7d mean — the first_seen birth cutoff excludes it.
    insertResolved("tenant-loop-birth", "ri_born_ancient", now - 730 * DAY_MS, now - DAY_MS);
    // Born and resolved inside the window: 9,000ms duration — the only mean sample.
    insertResolved("tenant-loop-birth", "ri_born_recent", now - 10_000, now - 1_000);

    const res = await withTenant("tenant-loop-birth", () => reasonerLoopStatsHandler());
    const { data } = await res.json() as { data: { resolved7d: number; meanTimeToResolveMs: number | null } };

    // Both closes count as closes...
    expect(data.resolved7d).toBe(2);
    // ...but only the born-in-window row feeds the mean.
    expect(data.meanTimeToResolveMs).toBe(9_000);
  });

  test("no rows born AND resolved inside the window → mean_ttr_ms is null, not skewed by ancient closes", async () => {
    const now = Date.now();
    // Resolved outside the window entirely.
    insertResolved("tenant-loop-empty", "ri_only_ancient", now - 900 * DAY_MS, now - 30 * DAY_MS);
    // Resolved inside the window but born years ago: counts as a close,
    // never as a mean sample — mean must be null, not a fake number.
    insertResolved("tenant-loop-empty", "ri_close_only", now - 730 * DAY_MS, now - DAY_MS);

    const res = await withTenant("tenant-loop-empty", () => reasonerLoopStatsHandler());
    const { data } = await res.json() as { data: { resolved7d: number; meanTimeToResolveMs: number | null } };

    expect(data.resolved7d).toBe(1);
    expect(data.meanTimeToResolveMs).toBeNull();
  });
});
