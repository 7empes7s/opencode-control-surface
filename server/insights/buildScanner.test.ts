import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { getAiAnalysis } from "./ai.ts";
import { runBuildScan } from "./scanners/build.ts";
import { getInsight } from "./store.ts";
import { seedPlaybooks } from "../reasoner/playbooks.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "build-scanner-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  seedPlaybooks(getDashboardDb()!);
});

afterEach(() => {
  closeDashboardDb();
  if (prevDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = prevDb;
  if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

function seedFailedBuildDiagnosis(runStatus = "failed") {
  const now = Date.now();
  const db = getDashboardDb()!;
  db.query(`
    INSERT INTO builder_workflows
      (id, project_id, name, mode, status, plan_file, config_json, created_at, updated_at, tenant_id)
    VALUES ('wf-build', 'project-1', 'Build workflow', 'plan', 'active', 'plan.md', '{}', ?, ?, 'mimule')
  `).run(now, now);
  db.query(`
    INSERT INTO builder_runs
      (id, workflow_id, trigger, status, started_at, tenant_id)
    VALUES ('run-build', 'wf-build', 'manual', ?, ?, 'mimule')
  `).run(runStatus, now);
  db.query(`
    INSERT INTO reasoner_diagnoses
      (id, pass_id, run_id, workflow_id, failure_class, root_cause, evidence_json,
       suggested_actions_json, confidence, diagnosed_at, tenant_id)
    VALUES ('diag-build', 'pass-build', 'run-build', 'wf-build', 'pass-timeout',
      'The pass timed out while waiting for validation', '["stdout tail"]',
      '["Retry with continuation context"]', 'high', ?, 'mimule')
  `).run(now);
}

describe("build scanner", () => {
  test("failed builder diagnosis becomes a pre-reasoned build insight", () => {
    seedFailedBuildDiagnosis();

    const result = runBuildScan();
    expect(result.findings.length).toBe(1);

    const insight = getInsight("insight_build_diagnosis_diag-build");
    expect(insight?.domain).toBe("build");
    expect(insight?.sourceKey).toBe("build:run-build");
    expect(insight?.severity).toBe("high");
    expect(insight?.actionDescriptorId).toMatch(/^reasoner-remediate:pass-timeout:/);

    const ai = getAiAnalysis("insight_build_diagnosis_diag-build");
    expect(ai?.summary).toContain("Retry with continuation context");
    expect(ai?.model).toBe("reasoner-diagnosis");
  });

  test("resolved builder run clears stale build insight", () => {
    seedFailedBuildDiagnosis();
    runBuildScan();

    getDashboardDb()!.query("UPDATE builder_runs SET status = 'succeeded' WHERE id = 'run-build'").run();
    const result = runBuildScan();

    expect(result.resolved.map((row) => row.id)).toContain("insight_build_diagnosis_diag-build");
    expect(getInsight("insight_build_diagnosis_diag-build")?.status).toBe("resolved");
  });
});
