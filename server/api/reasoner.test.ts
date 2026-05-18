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
    const bodyA = await resA.json() as Array<{ workflowId: string }>;
    expect(bodyA.length).toBe(1);
    expect(bodyA[0].workflowId).toBe("wf-a");

    const resB = await withTenant("tenant-b", () => reasonerJobsHandler());
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as Array<{ workflowId: string }>;
    expect(bodyB.length).toBe(1);
    expect(bodyB[0].workflowId).toBe("wf-b");
  });

  test("diagnoses list only returns current tenant diagnoses", async () => {
    insertDiagnosis("tenant-a", "pass-a", "run-a", "wf-a");
    insertDiagnosis("tenant-b", "pass-b", "run-b", "wf-b");

    const resA = await withTenant("tenant-a", () => reasonerDiagnosesHandler());
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as Array<{ workflowId: string }>;
    expect(bodyA.length).toBe(1);
    expect(bodyA[0].workflowId).toBe("wf-a");

    const resB = await withTenant("tenant-b", () => reasonerDiagnosesHandler());
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as Array<{ workflowId: string }>;
    expect(bodyB.length).toBe(1);
    expect(bodyB[0].workflowId).toBe("wf-b");
  });

  test("incidents list only returns current tenant incidents", async () => {
    insertIncident("tenant-a", "inc-a", "Incident A");
    insertIncident("tenant-b", "inc-b", "Incident B");

    const resA = await withTenant("tenant-a", () => reasonerIncidentsHandler());
    expect(resA.status).toBe(200);
    const bodyA = await resA.json() as Array<{ title: string }>;
    expect(bodyA.length).toBe(1);
    expect(bodyA[0].title).toBe("Incident A");

    const resB = await withTenant("tenant-b", () => reasonerIncidentsHandler());
    expect(resB.status).toBe(200);
    const bodyB = await resB.json() as Array<{ title: string }>;
    expect(bodyB.length).toBe(1);
    expect(bodyB[0].title).toBe("Incident B");
  });
});
