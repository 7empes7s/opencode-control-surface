import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeDashboardDb, initDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { withTenantContext } from "../tenancy/middleware.ts";
import {
  createBuilderWorkflow,
  provisionProject,
  readBuilderArtifacts,
  readBuilderPasses,
  readBuilderRun,
  readBuilderRuns,
  readBuilderValidations,
  readBuilderWorkflow,
  readBuilderWorkflows,
} from "./store.ts";

let tempDir: string;
let prevDb: string | undefined;
let prevDbPath: string | undefined;
let prevProvisionRoots: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "builder-store-test-"));
  prevDb = process.env.DASHBOARD_DB;
  prevDbPath = process.env.DASHBOARD_DB_PATH;
  prevProvisionRoots = process.env.BUILDER_PROVISION_ROOTS_ALLOW;
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
  if (prevProvisionRoots === undefined) delete process.env.BUILDER_PROVISION_ROOTS_ALLOW;
  else process.env.BUILDER_PROVISION_ROOTS_ALLOW = prevProvisionRoots;
  rmSync(tempDir, { recursive: true, force: true });
});

function reqFor(tenantId: string): Request {
  return new Request("http://localhost/api/test", {
    headers: { "x-tenant-id": tenantId },
  });
}

async function asTenant<T>(tenantId: string, fn: () => T): Promise<T> {
  let result: T;
  await withTenantContext(async () => {
    result = fn();
    return new Response("ok");
  })(reqFor(tenantId));
  return result!;
}

function writePlanFile(path: string): void {
  writeFileSync(path, "# Plan\n\n## Phase 1\n- [ ] item\n", "utf8");
}

describe("cross-tenant builder workflow isolation", () => {
  test("tenant A workflows are not visible to tenant B in list", async () => {
    const planPath = join(tempDir, "plan-a.md");
    writePlanFile(planPath);

    await asTenant("t-alpha", () =>
      createBuilderWorkflow({
        name: "Alpha workflow",
        projectRoot: "/opt/opencode-control-surface",
        planFile: planPath,
        mode: "once",
        status: "draft",
        config: {
          projectRoot: "/opt/opencode-control-surface",
          agentOrder: ["opencode"],
          modelPolicy: { fallbackTargets: [] },
          validationProfile: { commands: ["true"], internal: ["true"], runtime: [], public: [] },
          gitPolicy: { commit: "manual", push: "never" },
          backupPolicy: { enabled: false, beforeRun: false },
          riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
        },
      }),
    );

    const alphaList = await asTenant("t-alpha", () => readBuilderWorkflows());
    expect(alphaList).toHaveLength(1);
    expect(alphaList[0].name).toBe("Alpha workflow");

    const betaList = await asTenant("t-beta", () => readBuilderWorkflows());
    expect(betaList).toHaveLength(0);
  });

  test("tenant B cannot read tenant A workflow by id", async () => {
    const planPath = join(tempDir, "plan-b.md");
    writePlanFile(planPath);

    const workflow = await asTenant("t-alpha", () =>
      createBuilderWorkflow({
        name: "Alpha workflow 2",
        projectRoot: "/opt/opencode-control-surface",
        planFile: planPath,
        mode: "once",
        status: "draft",
        config: {
          projectRoot: "/opt/opencode-control-surface",
          agentOrder: ["opencode"],
          modelPolicy: { fallbackTargets: [] },
          validationProfile: { commands: ["true"], internal: ["true"], runtime: [], public: [] },
          gitPolicy: { commit: "manual", push: "never" },
          backupPolicy: { enabled: false, beforeRun: false },
          riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
        },
      }),
    );

    const alphaRead = await asTenant("t-alpha", () => readBuilderWorkflow(workflow.id));
    expect(alphaRead).not.toBeNull();
    expect(alphaRead!.name).toBe("Alpha workflow 2");

    const betaRead = await asTenant("t-beta", () => readBuilderWorkflow(workflow.id));
    expect(betaRead).toBeNull();
  });

  test("null tenant_id workflows are visible to mimule tenant only", async () => {
    const planPath = join(tempDir, "plan-c.md");
    writePlanFile(planPath);

    const workflow = await asTenant("mimule", () =>
      createBuilderWorkflow({
        name: "Mimule legacy workflow",
        projectRoot: "/opt/opencode-control-surface",
        planFile: planPath,
        mode: "once",
        status: "draft",
        config: {
          projectRoot: "/opt/opencode-control-surface",
          agentOrder: ["opencode"],
          modelPolicy: { fallbackTargets: [] },
          validationProfile: { commands: ["true"], internal: ["true"], runtime: [], public: [] },
          gitPolicy: { commit: "manual", push: "never" },
          backupPolicy: { enabled: false, beforeRun: false },
          riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
        },
      }),
    );

    // Simulate legacy row by nulling tenant_id
    const db = getDashboardDb()!;
    db.query(`UPDATE builder_workflows SET tenant_id = NULL WHERE id = ?`).run(workflow.id);

    const mimuleRead = await asTenant("mimule", () => readBuilderWorkflow(workflow.id));
    expect(mimuleRead).not.toBeNull();

    const otherRead = await asTenant("t-other", () => readBuilderWorkflow(workflow.id));
    expect(otherRead).toBeNull();
  });
});

describe("cross-tenant builder run isolation", () => {
  test("tenant A runs are not visible to tenant B", async () => {
    const planPath = join(tempDir, "plan-run.md");
    writePlanFile(planPath);

    const workflow = await asTenant("t-alpha", () =>
      createBuilderWorkflow({
        name: "Run test workflow",
        projectRoot: "/opt/opencode-control-surface",
        planFile: planPath,
        mode: "once",
        status: "draft",
        config: {
          projectRoot: "/opt/opencode-control-surface",
          agentOrder: ["opencode"],
          modelPolicy: { fallbackTargets: [] },
          validationProfile: { commands: ["true"], internal: ["true"], runtime: [], public: [] },
          gitPolicy: { commit: "manual", push: "never" },
          backupPolicy: { enabled: false, beforeRun: false },
          riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
        },
      }),
    );

    // Insert run rows directly to avoid spawning processes
    const db = getDashboardDb()!;
    const runId = `br_${randomUUID()}`;
    db.query(`
      INSERT INTO builder_runs (id, workflow_id, tenant_id, trigger, status, started_at, finished_at, current_pass_id,
        stop_requested_at, stop_requested_by, result_json, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, workflow.id, "t-alpha", "manual", "success", Date.now(), Date.now(), null, null, null, null, null);

    const alphaRuns = await asTenant("t-alpha", () => readBuilderRuns(workflow.id));
    expect(alphaRuns).toHaveLength(1);
    expect(alphaRuns[0].id).toBe(runId);

    const betaRuns = await asTenant("t-beta", () => readBuilderRuns(workflow.id));
    expect(betaRuns).toHaveLength(0);

    const alphaRun = await asTenant("t-alpha", () => readBuilderRun(runId));
    expect(alphaRun).not.toBeNull();

    const betaRun = await asTenant("t-beta", () => readBuilderRun(runId));
    expect(betaRun).toBeNull();
  });
});

describe("cross-tenant builder pass/artifact/validation isolation", () => {
  test("tenant A passes/artifacts/validations are not visible to tenant B", async () => {
    const planPath = join(tempDir, "plan-pav.md");
    writePlanFile(planPath);

    const workflow = await asTenant("t-alpha", () =>
      createBuilderWorkflow({
        name: "PAV test workflow",
        projectRoot: "/opt/opencode-control-surface",
        planFile: planPath,
        mode: "once",
        status: "draft",
        config: {
          projectRoot: "/opt/opencode-control-surface",
          agentOrder: ["opencode"],
          modelPolicy: { fallbackTargets: [] },
          validationProfile: { commands: ["true"], internal: ["true"], runtime: [], public: [] },
          gitPolicy: { commit: "manual", push: "never" },
          backupPolicy: { enabled: false, beforeRun: false },
          riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
        },
      }),
    );

    const db = getDashboardDb()!;
    const runId = `br_${randomUUID()}`;
    db.query(`
      INSERT INTO builder_runs (id, workflow_id, tenant_id, trigger, status, started_at, finished_at, current_pass_id,
        stop_requested_at, stop_requested_by, result_json, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, workflow.id, "t-alpha", "manual", "success", Date.now(), Date.now(), null, null, null, null, null);

    const passId = `bp_${randomUUID()}`;
    db.query(`
      INSERT INTO builder_passes (id, run_id, workflow_id, sequence, phase, status, agent, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(passId, runId, workflow.id, 1, "build", "success", "opencode", "t-alpha");

    const artifactId = `ba_${randomUUID()}`;
    db.query(`
      INSERT INTO builder_artifacts (id, workflow_id, run_id, pass_id, kind, path, sha256, created_at, metadata_json, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(artifactId, workflow.id, runId, passId, "stdout", "/tmp/log", null, Date.now(), null, "t-alpha");

    const validationId = `bv_${randomUUID()}`;
    db.query(`
      INSERT INTO builder_validations (id, workflow_id, run_id, pass_id, kind, status, command, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(validationId, workflow.id, runId, passId, "typecheck", "success", "bun run typecheck", "t-alpha");

    const alphaPasses = await asTenant("t-alpha", () => readBuilderPasses(runId));
    expect(alphaPasses).toHaveLength(1);
    expect(alphaPasses[0].id).toBe(passId);

    const betaPasses = await asTenant("t-beta", () => readBuilderPasses(runId));
    expect(betaPasses).toHaveLength(0);

    const alphaArtifacts = await asTenant("t-alpha", () => readBuilderArtifacts(runId));
    expect(alphaArtifacts).toHaveLength(1);
    expect(alphaArtifacts[0].id).toBe(artifactId);

    const betaArtifacts = await asTenant("t-beta", () => readBuilderArtifacts(runId));
    expect(betaArtifacts).toHaveLength(0);

    const alphaValidations = await asTenant("t-alpha", () => readBuilderValidations(runId));
    expect(alphaValidations).toHaveLength(1);
    expect(alphaValidations[0].id).toBe(validationId);

    const betaValidations = await asTenant("t-beta", () => readBuilderValidations(runId));
    expect(betaValidations).toHaveLength(0);
  });
});

describe("provision writes tenant_id", () => {
  test("provisioned project and workflow carry tenant_id", async () => {
    process.env.BUILDER_PROVISION_ROOTS_ALLOW = tempDir;
    const projectRoot = join(tempDir, "provisioned-project");

    const result = await asTenant("t-gamma", () =>
      provisionProject({
        projectRoot,
        name: "Gamma Project",
        planFile: join(projectRoot, "PLAN.md"),
        agentOrder: ["opencode"],
        fallbackTargets: [],
        validationCommands: ["bun run check"],
        gitPolicy: { commit: "manual", push: "never" },
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.workflowId).toBeTruthy();

    const db = getDashboardDb()!;
    const projectRow = db.query(`SELECT tenant_id FROM builder_projects WHERE id = ?`).get(result.id) as { tenant_id: string | null } | null;
    expect(projectRow?.tenant_id).toBe("t-gamma");

    const workflowRow = db.query(`SELECT tenant_id FROM builder_workflows WHERE id = ?`).get(result.workflowId) as { tenant_id: string | null } | null;
    expect(workflowRow?.tenant_id).toBe("t-gamma");
  });

  test("workflow links to existing project id when root is already registered", async () => {
    process.env.BUILDER_PROVISION_ROOTS_ALLOW = tempDir;
    const projectRoot = join(tempDir, "existing-project");
    const planPath = join(projectRoot, "PLAN.md");
    mkdirSync(projectRoot, { recursive: true });
    writePlanFile(planPath);

    const db = getDashboardDb()!;
    db.query(`
      INSERT INTO builder_projects (id, name, root, config_json, created_at, updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-project-id",
      "Existing Project",
      projectRoot,
      JSON.stringify({ root: projectRoot, label: "Existing Project", writable: true, risk: "medium" }),
      Date.now(),
      Date.now(),
      "mimule",
    );

    const workflow = await asTenant("mimule", () =>
      createBuilderWorkflow({
        name: "Existing root workflow",
        projectRoot,
        planFile: planPath,
        mode: "once",
        status: "draft",
        config: {
          projectRoot,
          agentOrder: ["opencode"],
          modelPolicy: { fallbackTargets: [] },
          validationProfile: { commands: ["true"], internal: ["true"], runtime: [], public: [] },
          gitPolicy: { commit: "manual", push: "never" },
          backupPolicy: { enabled: false, beforeRun: false },
          riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
        },
      }),
    );

    const row = db.query(`SELECT project_id FROM builder_workflows WHERE id = ?`).get(workflow.id) as { project_id: string } | null;
    expect(row?.project_id).toBe("legacy-project-id");
    expect(workflow.projectId).toBe("legacy-project-id");
  });
});
