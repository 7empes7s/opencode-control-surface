import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeDashboardDb, initDashboardDb, getDashboardDb } from "../db/dashboard.ts";
import { withTenantContext } from "../tenancy/middleware.ts";
import { DEFAULT_TENANT_ID } from "../tenancy/context.ts";
import {
  builderStateRoot,
  createBuilderPass,
  createBuilderRun,
  reconcileRunStatus,
  repeatedValidationFailurePauseReason,
  tmuxSocket,
  updateBuilderRun,
} from "./runner.ts";
import { createBuilderWorkflow, readBuilderPasses } from "./store.ts";
import type { BuilderPass, BuilderValidation } from "./store.ts";

describe("tmuxSocket", () => {
  test("returns tib-mimule for mimule tenant", () => {
    expect(tmuxSocket("mimule")).toBe("tib-mimule");
  });

  test("returns tib-acme for acme tenant", () => {
    expect(tmuxSocket("acme")).toBe("tib-acme");
  });

  test("returns tib-<id> for any tenant id", () => {
    expect(tmuxSocket("t-alpha")).toBe("tib-t-alpha");
    expect(tmuxSocket("t-beta")).toBe("tib-t-beta");
    expect(tmuxSocket("my-org")).toBe("tib-my-org");
  });

  test("resolves a custom socket prefix at call time", () => {
    const previous = process.env.BUILDER_TMUX_SOCKET_PREFIX;
    try {
      process.env.BUILDER_TMUX_SOCKET_PREFIX = " test-builder-";
      expect(tmuxSocket("mimule")).toBe("test-builder-mimule");
    } finally {
      if (previous === undefined) delete process.env.BUILDER_TMUX_SOCKET_PREFIX;
      else process.env.BUILDER_TMUX_SOCKET_PREFIX = previous;
    }
  });
});

test("builderStateRoot keeps the production default and resolves env changes at call time", () => {
  const previous = process.env.BUILDER_STATE_ROOT;
  try {
    delete process.env.BUILDER_STATE_ROOT;
    expect(builderStateRoot()).toBe("/var/lib/control-surface");
    process.env.BUILDER_STATE_ROOT = " /tmp/builder-test-state ";
    expect(builderStateRoot()).toBe("/tmp/builder-test-state");
  } finally {
    if (previous === undefined) delete process.env.BUILDER_STATE_ROOT;
    else process.env.BUILDER_STATE_ROOT = previous;
  }
});

function pass(id: string, sequence: number): BuilderPass {
  return {
    id,
    runId: "br_test",
    workflowId: "bw_test",
    sequence,
    phase: "build",
    status: "failed",
    agent: "codex",
    model: "o4-mini",
    provider: null,
    modelReason: null,
    startedAt: sequence,
    finishedAt: sequence + 1,
    jobIds: [],
    validationIds: [],
    artifactIds: [],
    summary: null,
    nextInstruction: null,
    error: null,
    failureClass: null,
    analyticsJson: null,
    planItemsDone: null,
    planItemsRemaining: null,
    completionPercent: null,
    traceId: null,
  };
}

function validation(passId: string, status: string, command = "bun run build"): BuilderValidation {
  return {
    id: `bv_${passId}`,
    workflowId: "bw_test",
    runId: "br_test",
    passId,
    kind: "build",
    status,
    command,
    url: null,
    startedAt: 1,
    finishedAt: 2,
    outputTail: null,
    artifactId: null,
    error: status === "success" ? null : "build failed",
  };
}

describe("repeatedValidationFailurePauseReason", () => {
  test("returns a pause reason after the configured consecutive validation failure threshold", () => {
    const reason = repeatedValidationFailurePauseReason(
      [pass("bp_1", 1), pass("bp_2", 2), pass("bp_3", 3)],
      [validation("bp_1", "failed"), validation("bp_2", "failed"), validation("bp_3", "failed")],
      3,
    );

    expect(reason).toContain("3 consecutive passes ended with validation failures");
    expect(reason).toContain("bun run build");
  });

  test("does not pause when a recent validation pass breaks the failure streak", () => {
    const reason = repeatedValidationFailurePauseReason(
      [pass("bp_1", 1), pass("bp_2", 2), pass("bp_3", 3)],
      [validation("bp_1", "failed"), validation("bp_2", "failed"), validation("bp_3", "success")],
      3,
    );

    expect(reason).toBeNull();
  });
});

// ── reconcileRunStatus: a validation-only failure must queue a reasoner diagnosis ──
//
// Regression coverage for the fix at the "Correct the pass status to reflect validation"
// block in runner.ts: previously, when an agent pass exited 0 but its change broke the
// project's own validation command, the pass was downgraded to failureClass
// "validation-failed"/"build-failed" *after* the one and only queueDiagnosis() call site
// in this file had already run (and skipped, because at that point the agent's own exit
// code still looked like a success). That meant these failures never got a
// reasoner_diagnoses row, so the Insights Inbox (mapReasonerBuildFindings in
// server/insights/scanners/build.ts, which reads reasoner_diagnoses, not builder_passes)
// never surfaced them, and the built-in "validation-failed -> Surface to operator"
// playbook could never be matched for them. This test drives the real reconciliation
// path (no mocked spawnSync/tmux — same idiom the rest of this codebase's integration
// tests use) and asserts a reasoner_jobs row is queued for that pass.
describe("reconcileRunStatus — validation-only failure", () => {
  let tempDir: string;
  let prevDb: string | undefined;
  let prevDbPath: string | undefined;
  let prevBuilderStateRoot: string | undefined;
  let prevBuilderTmuxSocketPrefix: string | undefined;
  let testTmuxSocketPrefix: string;
  // Scoped to this test's temp builder state root and unique project id.
  let projectRunsDir: string | null = null;

  function reqFor(tenantId: string): Request {
    return new Request("http://localhost/api/test", { headers: { "x-tenant-id": tenantId } });
  }

  async function asTenant<T>(tenantId: string, fn: () => T | Promise<T>): Promise<T> {
    let result: T;
    await withTenantContext(async () => {
      result = await fn();
      return new Response("ok");
    })(reqFor(tenantId));
    return result!;
  }

  function sanitize(id: string): string {
    return id.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  beforeEach(() => {
    closeDashboardDb();
    tempDir = mkdtempSync(join(tmpdir(), "runner-validation-fail-test-"));
    prevDb = process.env.DASHBOARD_DB;
    prevDbPath = process.env.DASHBOARD_DB_PATH;
    prevBuilderStateRoot = process.env.BUILDER_STATE_ROOT;
    prevBuilderTmuxSocketPrefix = process.env.BUILDER_TMUX_SOCKET_PREFIX;
    testTmuxSocketPrefix = `tib-test-${randomUUID().slice(0, 8)}-`;
    process.env.DASHBOARD_DB = "1";
    process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
    process.env.BUILDER_STATE_ROOT = join(tempDir, "builder-state");
    process.env.BUILDER_TMUX_SOCKET_PREFIX = testTmuxSocketPrefix;
    initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
    projectRunsDir = null;
  });

  afterEach(() => {
    closeDashboardDb();
    spawnSync("tmux", ["-L", `${testTmuxSocketPrefix}mimule`, "kill-server"], { stdio: "ignore" });
    if (prevDb === undefined) delete process.env.DASHBOARD_DB;
    else process.env.DASHBOARD_DB = prevDb;
    if (prevDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = prevDbPath;
    if (prevBuilderStateRoot === undefined) delete process.env.BUILDER_STATE_ROOT;
    else process.env.BUILDER_STATE_ROOT = prevBuilderStateRoot;
    if (prevBuilderTmuxSocketPrefix === undefined) delete process.env.BUILDER_TMUX_SOCKET_PREFIX;
    else process.env.BUILDER_TMUX_SOCKET_PREFIX = prevBuilderTmuxSocketPrefix;
    rmSync(tempDir, { recursive: true, force: true });
    if (projectRunsDir) rmSync(projectRunsDir, { recursive: true, force: true });
  });

  test("a pass that exits 0 but fails its validation command queues a reasoner diagnosis", async () => {
    const planPath = join(tempDir, "PLAN.md");
    writeFileSync(planPath, "# Plan\n\n- [ ] item\n", "utf8");
    // Use the real default tenant: builder_passes rows are written without a tenant_id
    // stamp (see createBuilderPass in runner.ts — it has no tenant column in its INSERT),
    // and readBuilderPasses()'s tenant filter only treats NULL tenant_id rows as belonging
    // to the DEFAULT tenant (server/db/tenantScope.ts, whereTenant()) — a synthetic
    // non-default tenant id would make the pass invisible to its own reads. This test's
    // file writes are scoped to BUILDER_STATE_ROOT under tempDir (see projectRunsDir
    // below), so they cannot collide with the live service's own "mimule" data.
    const tenantId = DEFAULT_TENANT_ID;

    // Register the temp dir as a known project directly in builder_projects (the same
    // table server/builder/provision.ts's store-side writer inserts into) so
    // createBuilderWorkflow's allowlist check (getAllowedProject) resolves it, without
    // pulling in the full HTTP-facing provisioning flow this unit test doesn't need.
    getDashboardDb()!.query(`
      INSERT INTO builder_projects (id, name, root, config_json, created_at, updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `project:${tempDir}`,
      "runner-test project",
      tempDir,
      JSON.stringify({ root: tempDir, label: "runner-test project", risk: "medium", writable: true, note: "" }),
      Date.now(),
      Date.now(),
      tenantId,
    );

    const workflow = await asTenant(tenantId, () =>
      createBuilderWorkflow({
        name: "validation-only failure test",
        projectRoot: tempDir,
        planFile: planPath,
        mode: "once",
        status: "ready",
        config: {
          projectRoot: tempDir,
          agentOrder: ["opencode"],
          modelPolicy: { fallbackTargets: [] },
          // A deterministic, always-failing "validation command" — stands in for
          // `bun test` catching a real regression while the agent process itself exits 0.
          validationProfile: { commands: ["exit 7"], internal: ["exit 7"], runtime: [], public: [] },
          gitPolicy: { commit: "manual", push: "never" },
          backupPolicy: { enabled: false, beforeRun: false },
          riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
        },
      }));

    const run = await asTenant(tenantId, () => createBuilderRun(workflow.id, "manual", "test"));
    const passId = await asTenant(tenantId, () =>
      createBuilderPass({
        runId: run.id,
        workflowId: workflow.id,
        sequence: 1,
        phase: "implement",
        agent: "opencode",
        model: null,
        provider: "opencode",
      }));
    await asTenant(tenantId, () => updateBuilderRun(run.id, { currentPassId: passId }));

    // Simulate the tmux pass having already finished with exit code 0 (agent "succeeded"),
    // with no tmux session left for reconcileRunStatus to find — the same state it reads
    // in production once the real pass script's tmux session has exited.
    projectRunsDir = join(process.env.BUILDER_STATE_ROOT!, "tenants", sanitize(tenantId), "projects", sanitize(workflow.projectId));
    const runDirPath = join(projectRunsDir, "builder-runs", run.id);
    mkdirSync(runDirPath, { recursive: true });
    writeFileSync(join(runDirPath, "pass-1-exit.code"), "0", "utf8");
    writeFileSync(join(runDirPath, "pass-1-stdout.log"), "ran ok\n", "utf8");
    writeFileSync(join(runDirPath, "pass-1-stderr.log"), "", "utf8");

    await asTenant(tenantId, () => reconcileRunStatus(run.id));

    const passes = await asTenant(tenantId, () => readBuilderPasses(run.id));
    const finishedPass = passes.find((p) => p.id === passId);
    expect(finishedPass?.status).toBe("failed");
    expect(finishedPass?.failureClass).toBe("validation-failed");

    const db = getDashboardDb()!;
    const jobRow = db.query(`SELECT status, pass_id, run_id, workflow_id FROM reasoner_jobs WHERE pass_id = ?`).get(passId) as
      | { status: string; pass_id: string; run_id: string; workflow_id: string }
      | null;
    expect(jobRow).toBeTruthy();
    expect(jobRow?.status).toBe("pending");
    expect(jobRow?.run_id).toBe(run.id);
    expect(jobRow?.workflow_id).toBe(workflow.id);
  });
});
