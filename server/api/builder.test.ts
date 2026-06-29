import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readActionAudit } from "../db/writer.ts";
import type { ApiEnvelope } from "./types.ts";
import {
  builderCreateWorkflowHandler,
  builderDiscoverHandler,
  builderModelsHandler,
  builderPauseWorkflowHandler,
  builderProvisionHandler,
  builderRepairBaselineHandler,
  builderProjectsHandler,
  builderRunHandler,
  builderRunSummaryHandler,
  builderResumeWorkflowHandler,
  builderRunnerDisabledHandler,
  builderStartWorkflowHandler,
  builderStopWorkflowHandler,
  builderWorkflowsHandler,
  type BuilderProvisionResponse,
  type BuilderRepairBaselineResponse,
  type BuilderProjectsResponse,
  type BuilderRunResponse,
  type BuilderRunSummaryResponse,
  type BuilderWorkflowResponse,
  type BuilderWorkflowsResponse,
} from "./builder.ts";
import type { BuilderDiscovery, BuilderModelsInventory } from "../builder/discovery.ts";
import { readBuilderRuns, readBuilderWorkflow } from "../builder/store.ts";
import { selectModelForRole } from "../builder/modelSelector.ts";
import { getValidationProfileStartBlockers } from "../builder/validation-profile.ts";
import { repeatedValidationFailurePauseReason } from "../builder/runner.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousProvisionRootsAllow: string | undefined;
let previousProvisionedRoots: string | undefined;
let previousAgenticModelsPath: string | undefined;
let previousPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "builder-api-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  previousProvisionRootsAllow = process.env.BUILDER_PROVISION_ROOTS_ALLOW;
  previousProvisionedRoots = process.env.BUILDER_PROVISIONED_ROOTS;
  previousAgenticModelsPath = process.env.BUILDER_AGENTIC_MODELS_PATH;
  previousPath = process.env.PATH;
});

afterEach(() => {
  closeDashboardDb();
  if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDashboardDb;
  if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
  if (previousProvisionRootsAllow === undefined) delete process.env.BUILDER_PROVISION_ROOTS_ALLOW;
  else process.env.BUILDER_PROVISION_ROOTS_ALLOW = previousProvisionRootsAllow;
  if (previousProvisionedRoots === undefined) delete process.env.BUILDER_PROVISIONED_ROOTS;
  else process.env.BUILDER_PROVISIONED_ROOTS = previousProvisionedRoots;
  if (previousAgenticModelsPath === undefined) delete process.env.BUILDER_AGENTIC_MODELS_PATH;
  else process.env.BUILDER_AGENTIC_MODELS_PATH = previousAgenticModelsPath;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(tempDir, { recursive: true, force: true });
  rmSync("/opt/ai-vault/projects/test-provisioned-api-project.md", { force: true });
});

function enableDb(): void {
  process.env.DASHBOARD_DB = "1";
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });
}

test("builder projects includes control surface", async () => {
  const response = builderProjectsHandler();
  expect(response.status).toBe(200);

  const envelope = await response.json() as ApiEnvelope<BuilderProjectsResponse>;
  expect(envelope.data.projects.some((project) => project.root === "/opt/opencode-control-surface")).toBe(true);
});

test("builder discovery finds the phase-one dashboard prerequisites", async () => {
  const response = builderDiscoverHandler(new URL("/api/builder/discover?root=/opt/opencode-control-surface", "http://localhost"));
  expect(response.status).toBe(200);

  const envelope = await response.json() as ApiEnvelope<BuilderDiscovery>;
  const data = envelope.data;

  expect(data.project.root).toBe("/opt/opencode-control-surface");
  expect(data.planCandidates.some((plan) => plan.path === "/root/DASHBOARD_V4_PLAN.md" && plan.exists)).toBe(true);
  expect(data.skills.some((skill) => skill.name === "dashboard-orchestrator" && skill.status === "ok")).toBe(true);
  expect(data.validation.commands).toContain("bun run typecheck");
  expect(data.validation.commands).toContain("bun run build");
  expect(data.urls.internal).toBe("http://127.0.0.1:3000");
  expect(data.urls.public).toBe("https://control.techinsiderbytes.com");
  expect(data.git.status).toBe("ok");
});

test("builder discovery rejects roots outside the allowlist", async () => {
  const response = builderDiscoverHandler(new URL("/api/builder/discover?root=/etc", "http://localhost"));
  expect(response.status).toBe(400);
});

test("builder model inventory returns stable summary fields", async () => {
  const response = builderModelsHandler();
  expect(response.status).toBe(200);

  const envelope = await response.json() as ApiEnvelope<BuilderModelsInventory>;
  expect(envelope.data).toHaveProperty("bestLocal");
  expect(envelope.data).toHaveProperty("bestCloudHeavy");
  expect(envelope.data).toHaveProperty("bestCloudFast");
  expect(Array.isArray(envelope.data.fallbackTargets)).toBe(true);
  expect(Array.isArray(envelope.data.opencode)).toBe(true);
});

test("builder run summary exposes run-detail health signals", async () => {
  enableDb();
  const db = getDashboardDb()!;
  const now = Date.now();

  db.query(`
    INSERT INTO builder_runs (id, workflow_id, trigger, status, started_at, finished_at, current_pass_id, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("br_health", "bw_health", "manual", "failed", now - 120_000, now, "bp_health", "validation failed");
  db.query(`
    INSERT INTO builder_passes (
      id, run_id, workflow_id, sequence, phase, status, agent, model, started_at, finished_at,
      job_ids_json, validation_ids_json, artifact_ids_json, summary, failure_class, error, analytics_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "bp_health",
    "br_health",
    "bw_health",
    1,
    "implement",
    "failed",
    "codex",
    "gpt-5",
    now - 110_000,
    now - 10_000,
    "[]",
    JSON.stringify(["bv_fail", "bv_preview"]),
    JSON.stringify(["ba_dirty"]),
    "Pass timed out after no useful stdout.",
    "timeout",
    "stalled waiting for output",
    JSON.stringify({ filesEdited: ["app/page.tsx"], planItemsRemaining: 2 }),
  );
  db.query(`
    INSERT INTO builder_validations (
      id, workflow_id, run_id, pass_id, kind, status, command, url, started_at,
      finished_at, output_tail, artifact_id, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "bv_fail",
    "bw_health",
    "br_health",
    "bp_health",
    "web-build",
    "failed",
    "npm run build:web",
    null,
    now - 90_000,
    now - 80_000,
    "Type error in app/page.tsx",
    null,
    "build failed",
  );
  db.query(`
    INSERT INTO builder_validations (
      id, workflow_id, run_id, pass_id, kind, status, command, url, started_at,
      finished_at, output_tail, artifact_id, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "bv_preview_old",
    "bw_health",
    "br_health",
    "bp_health",
    "preview-old",
    "skipped",
    "curl -fsS http://127.0.0.1:5172/",
    "http://127.0.0.1:5172/",
    now - 79_000,
    now - 78_000,
    "older preview skipped",
    null,
    null,
  );
  db.query(`
    INSERT INTO builder_validations (
      id, workflow_id, run_id, pass_id, kind, status, command, url, started_at,
      finished_at, output_tail, artifact_id, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "bv_preview",
    "bw_health",
    "br_health",
    "bp_health",
    "preview-web",
    "ok",
    "curl -fsS http://127.0.0.1:5173/",
    "http://127.0.0.1:5173/",
    now - 70_000,
    now - 60_000,
    "ok",
    null,
    null,
  );
  db.query(`
    INSERT INTO builder_artifacts (id, workflow_id, run_id, pass_id, kind, path, sha256, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ba_dirty",
    "bw_health",
    "br_health",
    "bp_health",
    "pre-pass-dirty-state",
    "/tmp/pre-pass.patch",
    null,
    now - 100_000,
    JSON.stringify({ dirtyFiles: 3 }),
  );
  const stdoutPath = join(tempDir, "bp_health-stdout.log");
  writeFileSync(stdoutPath, "Planning repair\n[builder] running validation\nApplied patch\n", "utf8");
  db.query(`
    INSERT INTO builder_artifacts (id, workflow_id, run_id, pass_id, kind, path, sha256, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ba_stdout",
    "bw_health",
    "br_health",
    "bp_health",
    "stdout",
    stdoutPath,
    null,
    now - 50_000,
    "{}",
  );

  const response = builderRunSummaryHandler("br_health");
  expect(response.status).toBe(200);
  const envelope = await response.json() as ApiEnvelope<BuilderRunSummaryResponse>;

  expect(envelope.data.validationFailures).toHaveLength(1);
  expect(envelope.data.validationFailures[0].kind).toBe("web-build");
  expect(envelope.data.validationFailureTimeline).toHaveLength(1);
  expect(envelope.data.validationFailureTimeline[0].passSequence).toBe(1);
  expect(envelope.data.validationFailureTimeline[0].durationMs).toBe(10_000);
  expect(envelope.data.timeoutStallEvents).toHaveLength(1);
  expect(envelope.data.timeoutStallEvents[0].kind).toBe("timeout+stall");
  expect(envelope.data.timeoutCount).toBe(1);
  expect(envelope.data.stallCount).toBe(1);
  expect(envelope.data.dirtyFileCount).toBe(3);
  expect(envelope.data.dirtyFileSnapshot?.passSequence).toBe(1);
  expect(envelope.data.previewStatus.status).toBe("ok");
  expect(envelope.data.previewStatus.label).toContain("preview-web");
  expect(envelope.data.modelQuality).toHaveLength(1);
  expect(envelope.data.modelQuality[0]).toMatchObject({
    model: "gpt-5",
    passCount: 1,
    failedPasses: 1,
    timeoutRate: 1,
    validationPassRate: 0.67,
    fileWriteProbe: "passed",
    averageUsefulStdoutIntervalMs: 50_000,
    lastStatus: "failed",
  });
});

test("builder repair baseline action creates focused workflow from build failures", async () => {
  enableDb();
  const db = getDashboardDb()!;
  const projectRoot = "/opt/opencode-control-surface";
  const planFile = join(tempDir, "REPAIR_SOURCE_PLAN.md");
  writeFileSync(planFile, "- [ ] Ship feature after build is green\n", "utf8");

  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Generated app roadmap",
      projectRoot,
      planFile,
      mode: "auto-continue",
      status: "ready",
      config: {
        projectRoot,
        agentOrder: ["codex"],
        modelPolicy: { fallbackTargets: ["zen-gpt-5-mini"] },
        validationProfile: { commands: ["bun run typecheck", "bun run build"], internal: [], runtime: [], public: [] },
        gitPolicy: { commit: "manual", push: "workflow-branch" },
        backupPolicy: { enabled: true, beforeRun: true },
        riskPolicy: { liveDeploys: "disabled", maxPasses: 8 },
      },
    }),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  const workflowId = created.data.workflow!.id;
  const now = Date.now();

  db.query(`
    INSERT INTO builder_runs (id, workflow_id, trigger, status, started_at, finished_at, current_pass_id, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("br_repair", workflowId, "manual", "failed", now - 120_000, now, "bp_repair", "build failed");
  db.query(`
    INSERT INTO builder_passes (
      id, run_id, workflow_id, sequence, phase, status, started_at, finished_at,
      job_ids_json, validation_ids_json, artifact_ids_json, summary, failure_class, error, analytics_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "bp_repair",
    "br_repair",
    workflowId,
    1,
    "validate",
    "failed",
    now - 90_000,
    now - 60_000,
    "[]",
    JSON.stringify(["bv_repair"]),
    "[]",
    "Build failed during baseline validation.",
    "validation-failed",
    "TypeScript compile failed",
    "{}",
  );
  db.query(`
    INSERT INTO builder_validations (
      id, workflow_id, run_id, pass_id, kind, status, command, url, started_at,
      finished_at, output_tail, artifact_id, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "bv_repair",
    workflowId,
    "br_repair",
    "bp_repair",
    "web-build",
    "failed",
    "bun run build",
    null,
    now - 80_000,
    now - 70_000,
    "src/app.ts:42:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
    null,
    "compile failed",
  );

  const response = await builderRepairBaselineHandler("br_repair", new Request("http://localhost/api/builder/runs/br_repair/repair-baseline", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  }));
  expect(response.status).toBe(201);
  const envelope = await response.json() as ApiEnvelope<BuilderRepairBaselineResponse>;
  const repairWorkflow = envelope.data.workflow!;
  const repairPlanFile = envelope.data.repairPlanFile;

  expect(repairWorkflow.name).toContain("Repair build baseline");
  expect(repairWorkflow.status).toBe("ready");
  expect(repairWorkflow.mode).toBe("once");
  expect(repairWorkflow.projectRoot).toBe(projectRoot);
  expect(repairWorkflow.planFile).toBe(repairPlanFile);
  expect(repairWorkflow.config.riskPolicy.maxPasses).toBe(1);
  expect(repairWorkflow.config.gitPolicy.commit).toBe("manual");
  expect(repairWorkflow.config.gitPolicy.push).toBe("never");
  expect(readBuilderWorkflow(repairWorkflow.id)?.planFile).toBe(repairPlanFile);

  const repairPlan = readFileSync(repairPlanFile, "utf8");
  expect(repairPlan).toContain("Restore the compile/build baseline");
  expect(repairPlan).toContain("Command: `bun run build`");
  expect(repairPlan).toContain("TS2322");
  expect(repairPlan).toContain("Do not implement unrelated plan items");

  const audit = readActionAudit({ targetType: "builder-run" });
  expect(audit.some((row) => (
    row.actionKind === "builder.workflow.repair-baseline"
    && row.targetId === "br_repair"
    && row.resultStatus === "success"
  ))).toBe(true);

  rmSync(repairPlanFile, { force: true });
});

test("builder repeated validation failure policy detects a configured streak", () => {
  const passes = [
    { id: "bp_1", sequence: 1 },
    { id: "bp_2", sequence: 2 },
    { id: "bp_3", sequence: 3 },
  ] as Parameters<typeof repeatedValidationFailurePauseReason>[0];
  const validations = [
    { id: "bv_1", passId: "bp_1", kind: "typecheck", status: "failed", command: "bun run typecheck" },
    { id: "bv_2", passId: "bp_2", kind: "build", status: "failed", command: "bun run build" },
    { id: "bv_3", passId: "bp_3", kind: "build", status: "failed", command: "bun run build" },
  ] as Parameters<typeof repeatedValidationFailurePauseReason>[1];

  expect(repeatedValidationFailurePauseReason(passes, validations, 3)).toContain("3 consecutive passes");

  const recovered = [
    ...validations,
    { id: "bv_4", passId: "bp_4", kind: "build", status: "success", command: "bun run build" },
  ] as Parameters<typeof repeatedValidationFailurePauseReason>[1];
  const recoveredPasses = [
    ...passes,
    { id: "bp_4", sequence: 4 },
  ] as Parameters<typeof repeatedValidationFailurePauseReason>[0];
  expect(repeatedValidationFailurePauseReason(recoveredPasses, recovered, 3)).toBeNull();
});

test("builder workflow stores configured repeated-validation pause policy", async () => {
  enableDb();
  const response = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Validation pause policy",
      projectRoot: "/opt/opencode-control-surface",
      planFile: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
      mode: "auto-continue",
      status: "ready",
      config: {
        projectRoot: "/opt/opencode-control-surface",
        agentOrder: ["codex"],
        modelPolicy: { fallbackTargets: [] },
        validationProfile: { commands: ["bun run typecheck"], internal: [], runtime: [], public: [] },
        gitPolicy: { commit: "manual", push: "never" },
        backupPolicy: { enabled: false, beforeRun: false },
        riskPolicy: {
          liveDeploys: "disabled",
          maxPasses: 8,
          pauseOnRepeatedValidationFailure: { enabled: true, threshold: 99 },
        },
      },
    }),
    headers: { "Content-Type": "application/json" },
  }));

  expect(response.status).toBe(201);
  const created = await response.json() as ApiEnvelope<BuilderWorkflowResponse>;
  expect(created.data.workflow?.config.riskPolicy.pauseOnRepeatedValidationFailure).toEqual({
    enabled: true,
    threshold: 20,
  });
});

test("opencode agent model selection uses native provider/model ids", () => {
  const native = selectModelForRole("builder", {
    projectRoot: "/opt/opencode-control-surface",
    agentOrder: ["opencode"],
    modelPolicy: {
      builder: "opencode/minimax-m2.7",
      fallbackTargets: ["zen-minimax", "opencode/gpt-5.4-mini"],
    },
    validationProfile: { commands: [], internal: [], runtime: [], public: [] },
    gitPolicy: { commit: "manual", push: "never" },
    backupPolicy: { enabled: false, beforeRun: false },
    riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
  }, "opencode");
  expect(native.model).toBe("opencode/minimax-m2.7");

  const fallback = selectModelForRole("builder", {
    projectRoot: "/opt/opencode-control-surface",
    agentOrder: ["opencode"],
    modelPolicy: {
      builder: "zen-minimax",
      fallbackTargets: ["zen-minimax", "opencode/gpt-5.4-mini"],
    },
    validationProfile: { commands: [], internal: [], runtime: [], public: [] },
    gitPolicy: { commit: "manual", push: "never" },
    backupPolicy: { enabled: false, beforeRun: false },
    riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
  }, "opencode");
  expect(fallback.model).toBe("opencode/gpt-5.4-mini");
});

test("builder workflow draft survives through SQLite read model and audit", async () => {
  enableDb();
  const body = {
    name: "Dashboard V4.1 once",
    projectRoot: "/opt/opencode-control-surface",
    planFile: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
    mode: "once",
    status: "draft",
    config: {
      projectRoot: "/opt/opencode-control-surface",
      agentOrder: ["codex", "claude", "opencode"],
      modelPolicy: { fallbackTargets: ["codex", "claude"] },
      validationProfile: {
        commands: ["bun run typecheck", "bun run build"],
        internalUrl: "http://127.0.0.1:3000",
        publicUrl: "https://control.techinsiderbytes.com",
      },
      gitPolicy: { commit: "manual", push: "never" },
      backupPolicy: { enabled: true, beforeRun: true },
      riskPolicy: {
        liveDeploys: "disabled",
        maxPasses: 1,
        pauseOnRepeatedValidationFailure: { enabled: false, threshold: 5 },
      },
      sourceSession: {
        agent: "codex",
        sessionId: "cdx_test",
        title: "Dashboard chat handoff",
        directory: "/opt/opencode-control-surface",
        messageCount: 3,
        capturedAt: "2026-05-14T00:00:00.000Z",
        transcriptSummary: "Started: continue Dashboard V4\nTouched files: app/routes/BuilderPage.tsx",
        latestUserPrompt: "Continue development from the current session.",
        assistantSummary: "Implemented the Builder handoff controls.",
        touchedFiles: ["app/routes/BuilderPage.tsx", "server/api/builder.ts"],
        touchedFileSummary: "2 files referenced: app/routes/BuilderPage.tsx, server/api/builder.ts",
        recentTurns: [
          { role: "user", text: "Continue Dashboard V4." },
          { role: "assistant", text: "Implemented Builder handoff controls." },
        ],
      },
    },
  };

  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);

  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  expect(created.data.workflow?.status).toBe("draft");
  expect(created.data.workflow?.config.riskPolicy.pauseOnRepeatedValidationFailure).toEqual({ enabled: false, threshold: 5 });
  expect(created.data.workflow?.config.validationProfile.commands).toContain("bun run build");
  expect(created.data.workflow?.config.sourceSession?.agent).toBe("codex");
  expect(created.data.workflow?.config.sourceSession?.sessionId).toBe("cdx_test");
  expect(created.data.workflow?.config.sourceSession?.transcriptSummary).toContain("Dashboard V4");
  expect(created.data.workflow?.config.sourceSession?.latestUserPrompt).toContain("Continue development");
  expect(created.data.workflow?.config.sourceSession?.assistantSummary).toContain("handoff controls");
  expect(created.data.workflow?.config.sourceSession?.touchedFiles).toContain("server/api/builder.ts");
  expect(created.data.workflow?.config.sourceSession?.touchedFileSummary).toContain("2 files");
  expect(created.data.workflow?.config.sourceSession?.recentTurns?.[1]?.role).toBe("assistant");

  closeDashboardDb();
  process.env.DASHBOARD_DB = "1";
  initDashboardDb({ path: join(tempDir, "dashboard.sqlite") });

  const listResponse = builderWorkflowsHandler();
  const list = await listResponse.json() as ApiEnvelope<BuilderWorkflowsResponse>;
  expect(list.data.degraded).toBe(false);
  expect(list.data.workflows).toHaveLength(1);
  expect(list.data.workflows[0].name).toBe("Dashboard V4.1 once");

  const audit = readActionAudit({ targetType: "builder-workflow" });
  expect(audit.some((row) => row.actionKind === "builder.workflow.create")).toBe(true);
});

test("builder workflow list reconciles stale timeout and agentic-heavy model policy", async () => {
  enableDb();
  const catalogPath = join(tempDir, "agentic-models.json");
  process.env.BUILDER_AGENTIC_MODELS_PATH = catalogPath;
  writeFileSync(catalogPath, JSON.stringify({
    groups: {
      "agentic-heavy": [
        "openrouter/openai/gpt-oss-120b:free",
        "opencode/deepseek-v4-flash-free",
      ],
    },
  }));

  const body = {
    name: "Stale GaffrPro workflow",
    projectRoot: "/opt/opencode-control-surface",
    planFile: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
    mode: "auto-continue",
    status: "ready",
    config: {
      projectRoot: "/opt/opencode-control-surface",
      agentOrder: ["opencode:group:agentic-heavy:high"],
      modelPolicy: { fallbackTargets: [] },
      validationProfile: {
        commands: ["bun run typecheck"],
        internalUrl: "http://127.0.0.1:3000",
        publicUrl: "https://control.techinsiderbytes.com",
      },
      gitPolicy: { commit: "manual", push: "never" },
      backupPolicy: { enabled: false, beforeRun: false },
      riskPolicy: { liveDeploys: "disabled", maxPasses: 30, passTimeoutSeconds: 600, stallTimeoutSeconds: 900 },
    },
  };

  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  const workflowId = created.data.workflow!.id;

  const db = getDashboardDb();
  expect(db).not.toBeNull();
  db!.query(`UPDATE builder_workflows SET config_json = ? WHERE id = ?`).run(
    JSON.stringify(body.config),
    workflowId,
  );

  const listResponse = builderWorkflowsHandler();
  expect(listResponse.status).toBe(200);
  const list = await listResponse.json() as ApiEnvelope<BuilderWorkflowsResponse>;
  const workflow = list.data.workflows.find((item) => item.id === workflowId)!;
  expect(workflow.config.riskPolicy.maxPasses).toBe(120);
  expect(workflow.config.riskPolicy.passTimeoutSeconds).toBe(1500);
  expect(workflow.config.riskPolicy.stallTimeoutSeconds).toBe(2700);
  expect(workflow.config.riskPolicy.pauseOnRepeatedValidationFailure).toEqual({ enabled: true, threshold: 3 });
  expect(workflow.config.agentOrder).toEqual([
    "opencode:openrouter/openai/gpt-oss-120b:free:high",
    "opencode:opencode/deepseek-v4-flash-free:high",
  ]);
  expect(workflow.config.modelPolicy.fallbackTargets).toEqual([
    "openrouter/openai/gpt-oss-120b:free",
    "opencode/deepseek-v4-flash-free",
  ]);

  const raw = db!.query(`SELECT config_json FROM builder_workflows WHERE id = ?`).get(workflowId) as { config_json: string };
  const stored = JSON.parse(raw.config_json) as typeof workflow.config;
  expect(stored.riskPolicy.maxPasses).toBe(120);
  expect(stored.riskPolicy.pauseOnRepeatedValidationFailure).toEqual({ enabled: true, threshold: 3 });
  expect(stored.modelPolicy.fallbackTargets).toContain("opencode/deepseek-v4-flash-free");
});

test("builder runner mutations are explicitly disabled until phase three", async () => {
  const response = builderRunnerDisabledHandler("start");
  expect(response.status).toBe(409);
  const payload = await response.json() as { status: string; action: string };
  expect(payload.status).toBe("disabled");
  expect(payload.action).toBe("start");
});

test("builder provisioning creates project scaffold and draft workflow", async () => {
  enableDb();
  process.env.BUILDER_PROVISION_ROOTS_ALLOW = tempDir;
  const projectRoot = join(tempDir, "new-project");

  const response = await builderProvisionHandler(new Request("http://localhost/api/builder/provision", {
    method: "POST",
    body: JSON.stringify({
      name: "Test Provisioned API Project",
      projectRoot,
      description: "API-provisioned project for Builder tests",
      agentOrder: ["codex"],
      fallbackTargets: ["opencode/gpt-5.4-mini"],
      validationCommands: ["bun run check"],
      gitPolicy: { commit: "manual", push: "never" },
      runtimeScaffold: true,
    }),
    headers: { "Content-Type": "application/json" },
  }));

  expect(response.status).toBe(201);
  const envelope = await response.json() as ApiEnvelope<BuilderProvisionResponse>;
  const result = envelope.data.result;

  expect(result.error).toBeUndefined();
  expect(result.projectRoot).toBe(projectRoot);
  expect(result.workflowStatus).toBe("draft");
  expect(result.provisioned.agentsMd).toBe(true);
  expect(result.provisioned.planFile).toBe(join(projectRoot, "PLAN.md"));
  expect(result.provisioned.vaultNote).toBe(true);
  expect(result.provisioned.skillFile).toBe(true);
  expect(result.provisioned.validationProfileFile).toBe(join(projectRoot, ".opencode", "validation-profile.json"));
  expect(result.provisioned.runtimeScaffoldFiles).toEqual([
    join(projectRoot, "Dockerfile"),
    join(projectRoot, "compose.yaml"),
    join(projectRoot, ".opencode", "systemd", "test-provisioned-api-project.service"),
  ]);
  expect(result.validationCommands).toContain("bun run check");
  expect(existsSync(join(projectRoot, "AGENTS.md"))).toBe(true);
  expect(readFileSync(join(projectRoot, "Dockerfile"), "utf8")).toContain("oven/bun");
  expect(readFileSync(join(projectRoot, "compose.yaml"), "utf8")).toContain("services:");
  expect(readFileSync(join(projectRoot, ".opencode", "systemd", "test-provisioned-api-project.service"), "utf8")).toContain(`WorkingDirectory=${projectRoot}`);
  expect(readFileSync(join(projectRoot, "AGENTS.md"), "utf8")).toContain("Test Provisioned API Project");
  expect(readFileSync("/opt/ai-vault/projects/test-provisioned-api-project.md", "utf8")).toContain("API-provisioned project for Builder tests");
  expect(readFileSync(join(projectRoot, ".opencode", "skills", "project-workflow", "SKILL.md"), "utf8")).toContain("Test Provisioned API Project Project Workflow");
  expect(readFileSync(join(projectRoot, ".opencode", "validation-profile.json"), "utf8")).toContain("bun run check");

  const workflow = readBuilderWorkflow(result.workflowId);
  expect(workflow?.planFile).toBe(join(projectRoot, "PLAN.md"));
  expect(workflow?.config.validationProfile.commands).toContain("bun run check");
});

test("provisioned project discovery survives runtime allowlist reset", async () => {
  enableDb();
  process.env.BUILDER_PROVISION_ROOTS_ALLOW = tempDir;
  const projectRoot = join(tempDir, "persisted-project");

  const provisionResponse = await builderProvisionHandler(new Request("http://localhost/api/builder/provision", {
    method: "POST",
    body: JSON.stringify({
      name: "Persisted Builder Project",
      projectRoot,
      description: "Project should stay discoverable from SQLite after restart",
      agentOrder: ["codex"],
      validationCommands: ["bun run check"],
      gitPolicy: { commit: "manual", push: "never" },
      internalUrl: "http://127.0.0.1:4321",
    }),
    headers: { "Content-Type": "application/json" },
  }));

  expect(provisionResponse.status).toBe(201);
  delete process.env.BUILDER_PROVISIONED_ROOTS;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("BUILDER_ALLOWED_ROOT_")) delete process.env[key];
  }

  const projectsResponse = builderProjectsHandler();
  const projectsEnvelope = await projectsResponse.json() as ApiEnvelope<BuilderProjectsResponse>;
  const project = projectsEnvelope.data.projects.find((item) => item.root === projectRoot);
  expect(project?.label).toBe("Persisted Builder Project");
  expect(project?.internalUrl).toBe("http://127.0.0.1:4321");

  const discoverResponse = builderDiscoverHandler(new URL(`/api/builder/discover?root=${encodeURIComponent(projectRoot)}`, "http://localhost"));
  expect(discoverResponse.status).toBe(200);
  const discovery = await discoverResponse.json() as ApiEnvelope<BuilderDiscovery>;
  expect(discovery.data.project.root).toBe(projectRoot);
  expect(discovery.data.planCandidates.some((plan) => plan.path === join(projectRoot, "PLAN.md"))).toBe(true);
});

test("builder provisioning rejects protected service roots", async () => {
  enableDb();
  const response = await builderProvisionHandler(new Request("http://localhost/api/builder/provision", {
    method: "POST",
    body: JSON.stringify({
      name: "Bad Project",
      projectRoot: "/opt/newsbites/child",
    }),
    headers: { "Content-Type": "application/json" },
  }));

  expect(response.status).toBe(403);
});

test("builder workflow start creates run pass job and artifact rows", async () => {
  enableDb();
  const body = {
    name: "Startable workflow",
    projectRoot: "/opt/opencode-control-surface",
    planFile: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
    mode: "once",
    status: "draft",
    config: {
      projectRoot: "/opt/opencode-control-surface",
      agentOrder: ["codex"],
      modelPolicy: { fallbackTargets: [] },
      validationProfile: {
        commands: ["bun run typecheck"],
        internalUrl: "http://127.0.0.1:3000",
        publicUrl: "https://control.techinsiderbytes.com",
      },
      gitPolicy: { commit: "manual", push: "never" },
      backupPolicy: { enabled: false, beforeRun: false },
      riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
      sourceSession: {
        agent: "codex",
        sessionId: "cdx_live_handoff",
        title: "Scheduler plan handoff",
        directory: "/opt/opencode-control-surface",
        messageCount: 4,
        capturedAt: "2026-05-17T14:45:00.000Z",
        transcriptSummary: "Recent turns:\nuser: Dogfood the chat handoff into Builder.",
        latestUserPrompt: "Dogfood the chat handoff into Builder.",
        assistantSummary: "Prepared Builder source-session run detail coverage.",
        touchedFiles: ["app/components/AgentBuilderHandoffButton.tsx", "server/api/builder.test.ts"],
        touchedFileSummary: "2 files referenced: app/components/AgentBuilderHandoffButton.tsx, server/api/builder.test.ts",
        recentTurns: [
          { role: "user", text: "Dogfood the chat handoff into Builder." },
          { role: "assistant", text: "Prepared Builder source-session run detail coverage." },
        ],
      },
    },
  };

  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  const workflowId = created.data.workflow!.id;
  expect(created.data.workflow!.status).toBe("draft");

  const startResponse = await builderStartWorkflowHandler(workflowId, new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  }));
  expect(startResponse.status).toBe(201);

  const started = await startResponse.json() as ApiEnvelope<BuilderRunResponse>;
  expect(started.data.run).not.toBeNull();
  expect(started.data.run!.status).toBe("running");
  expect(started.data.passes.length).toBeGreaterThan(0);
  expect(started.data.artifacts.length).toBeGreaterThan(0);
  const scriptArtifact = started.data.artifacts.find((artifact) => artifact.kind === "command-script");
  expect(scriptArtifact).toBeTruthy();
  const script = readFileSync(scriptArtifact!.path, "utf8");
  // Script-level assertions: helpers are sourced, not embedded
  expect(script).toContain("builder-child-helpers.sh");
  expect(script).toContain("source \"$BUILDER_DIR/builder-child-helpers.sh\"");
  expect(script).toContain("export BASH_ENV=");
  expect(script).toContain('export PATH="$BUILDER_DIR/bin:$PATH"');
  expect(script).toContain('set +e');
  expect(script).toContain('echo "$EXIT_CODE" > "$BUILDER_DIR/pass-1-exit.code"');
  expect(script).not.toContain("${child_cmd}");
  const bashCheck = spawnSync("bash", ["-n", scriptArtifact!.path], { encoding: "utf8" });
  expect(bashCheck.status).toBe(0);
  // Helpers file assertions: sub-agent functions live in the sourced helpers file
  const helpersPath = scriptArtifact!.path.replace(/pass-\d+\.sh$/, "builder-child-helpers.sh");
  const helpers = existsSync(helpersPath) ? readFileSync(helpersPath, "utf8") : "";
  expect(helpers).toContain("builder_child_id_for_pid()");
  expect(helpers).toContain("builder-child-${RUN_ID}_");
  expect(helpers).toContain("BUILDER_CHILD_PASS_LOG");
  // Prompt file assertions: orchestration contract and context guidance live in the prompt
  const promptPath = scriptArtifact!.path.replace(/pass-\d+\.sh$/, "pass-1-prompt.txt");
  const promptContent = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "";
  expect(promptContent).toContain("child-context.txt");
  expect(promptContent).toContain("PLAN FILE NAVIGATION");

  const detailResponse = builderRunHandler(started.data.run!.id);
  expect(detailResponse.status).toBe(200);
  const detail = await detailResponse.json() as ApiEnvelope<BuilderRunResponse>;
  expect(detail.data.workflow?.id).toBe(workflowId);
  expect(detail.data.workflow?.config.sourceSession?.sessionId).toBe("cdx_live_handoff");
  expect(detail.data.workflow?.config.sourceSession?.latestUserPrompt).toContain("Dogfood");
  expect(detail.data.workflow?.config.sourceSession?.assistantSummary).toContain("run detail coverage");
  expect(detail.data.workflow?.config.sourceSession?.touchedFiles).toContain("server/api/builder.test.ts");
  expect(detail.data.workflow?.config.sourceSession?.recentTurns?.[1]?.role).toBe("assistant");

  // Stop immediately to clean up
  const stopResponse = await builderStopWorkflowHandler(workflowId, new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  }));
  expect(stopResponse.status).toBe(200);

  const stopped = await stopResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  expect(stopped.data.workflow!.status).toBe("ready");

  const runs = readBuilderRuns(workflowId);
  expect(runs.length).toBeGreaterThan(0);
  expect(runs[0].status).toBe("canceled");
});

test("builder workflow start rejects major runs without a project-local validation profile", async () => {
  enableDb();
  const projectRoot = join(tempDir, "generated-app");
  mkdirSync(projectRoot, { recursive: true });
  const planFile = join(projectRoot, "PLAN.md");
  writeFileSync(planFile, "# Generated App Plan\n", { encoding: "utf8" });
  getDashboardDb()!.query(`
    INSERT INTO builder_projects (id, name, root, config_json, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `project:${projectRoot}`,
    "Generated App",
    projectRoot,
    JSON.stringify({ label: "Generated App", risk: "medium", writable: true }),
    Date.now(),
    Date.now(),
    "mimule",
  );

  expect(getValidationProfileStartBlockers(projectRoot, { mode: "once", maxPasses: 2 }))
    .toContain(`project-local validation profile missing at ${join(projectRoot, ".opencode", "validation-profile.json")}`);

  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Major generated app workflow",
      projectRoot,
      planFile,
      mode: "once",
      status: "draft",
      config: {
        projectRoot,
        agentOrder: ["codex"],
        modelPolicy: { fallbackTargets: [] },
        validationProfile: { commands: ["bun run check"] },
        gitPolicy: { commit: "manual", push: "never" },
        backupPolicy: { enabled: false, beforeRun: false },
        riskPolicy: { liveDeploys: "disabled", maxPasses: 2 },
      },
    }),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  const workflowId = created.data.workflow!.id;

  const startResponse = await builderStartWorkflowHandler(workflowId, new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  }));

  expect(startResponse.status).toBe(409);
  const rejected = await startResponse.json() as { error?: string };
  expect(rejected.error).toContain("project-local validation profile required");
  expect(readBuilderRuns(workflowId)).toHaveLength(0);
});

test("builder workflow start rejects major runs when next plan items require unavailable services", async () => {
  enableDb();
  const projectRoot = join(tempDir, "ios-generated-app");
  mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
  const planFile = join(projectRoot, "PLAN.md");
  writeFileSync(planFile, [
    "# Generated iOS App Plan",
    "",
    "- [ ] Run real iOS simulators for release validation",
    "- [ ] Restore build validation baseline",
  ].join("\n"), { encoding: "utf8" });
  writeFileSync(join(projectRoot, ".opencode", "validation-profile.json"), JSON.stringify({
    installCommand: "npm ci",
    apiBuildCommand: "npm run build:api",
    webBuildCommand: "npm run build:web",
    apiSmokeCommand: "curl -fsS http://127.0.0.1:3000/health",
    webSmokeCommand: "curl -fsS http://127.0.0.1:3000/health",
    internal: ["npm run build:web"],
  }), { encoding: "utf8" });
  getDashboardDb()!.query(`
    INSERT INTO builder_projects (id, name, root, config_json, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `project:${projectRoot}`,
    "iOS Generated App",
    projectRoot,
    JSON.stringify({ label: "iOS Generated App", risk: "medium", writable: true }),
    Date.now(),
    Date.now(),
    "mimule",
  );

  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "iOS generated app workflow",
      projectRoot,
      planFile,
      mode: "once",
      status: "draft",
      config: {
        projectRoot,
        agentOrder: ["codex"],
        modelPolicy: { fallbackTargets: [] },
        validationProfile: { commands: ["npm run build:web"], internal: ["npm run build:web"] },
        gitPolicy: { commit: "manual", push: "never" },
        backupPolicy: { enabled: false, beforeRun: false },
        riskPolicy: { liveDeploys: "disabled", maxPasses: 2 },
      },
    }),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  const workflowId = created.data.workflow!.id;

  const startResponse = await builderStartWorkflowHandler(workflowId, new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  }));

  expect(startResponse.status).toBe(409);
  const rejected = await startResponse.json() as { error?: string };
  expect(rejected.error).toContain("plan sanity check failed");
  expect(rejected.error).toContain("real iOS simulator access");
  expect(readBuilderRuns(workflowId)).toHaveLength(0);
});

test("builder workflow start rejects major runs with unavailable external-service plan items", async () => {
  enableDb();
  const projectRoot = join(tempDir, "mobile-app");
  mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
  const planFile = join(projectRoot, "PLAN.md");
  writeFileSync(planFile, [
    "# Mobile App Plan",
    "",
    "- [ ] Submit the beta through TestFlight using EAS",
    "  - requires App Store Connect upload",
    "- [ ] Run regular web validation",
  ].join("\n"), { encoding: "utf8" });
  writeFileSync(join(projectRoot, ".opencode", "validation-profile.json"), JSON.stringify({
    installCommand: "npm ci",
    apiBuildCommand: "npm run build:api",
    webBuildCommand: "npm run build:web",
    apiSmokeCommand: "curl -fsS http://127.0.0.1:3000/health",
    webSmokeCommand: "curl -fsS http://127.0.0.1:3000/",
  }), { encoding: "utf8" });
  getDashboardDb()!.query(`
    INSERT INTO builder_projects (id, name, root, config_json, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `project:${projectRoot}`,
    "Mobile App",
    projectRoot,
    JSON.stringify({ label: "Mobile App", risk: "medium", writable: true }),
    Date.now(),
    Date.now(),
    "mimule",
  );

  const previousEasToken = process.env.EAS_TOKEN;
  const previousExpoToken = process.env.EXPO_TOKEN;
  const previousAscKey = process.env.APP_STORE_CONNECT_API_KEY;
  const previousAscKeyPath = process.env.APP_STORE_CONNECT_API_KEY_PATH;
  const previousAscPrivateKey = process.env.APP_STORE_CONNECT_PRIVATE_KEY;
  delete process.env.EAS_TOKEN;
  delete process.env.EXPO_TOKEN;
  delete process.env.APP_STORE_CONNECT_API_KEY;
  delete process.env.APP_STORE_CONNECT_API_KEY_PATH;
  delete process.env.APP_STORE_CONNECT_PRIVATE_KEY;
  try {
    const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Major mobile workflow",
        projectRoot,
        planFile,
        mode: "once",
        status: "draft",
        config: {
          projectRoot,
          agentOrder: ["codex"],
          modelPolicy: { fallbackTargets: [] },
          validationProfile: { commands: ["npm run build:web"] },
          gitPolicy: { commit: "manual", push: "never" },
          backupPolicy: { enabled: false, beforeRun: false },
          riskPolicy: { liveDeploys: "disabled", maxPasses: 2 },
        },
      }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
    const workflowId = created.data.workflow!.id;

    const startResponse = await builderStartWorkflowHandler(workflowId, new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    }));

    expect(startResponse.status).toBe(409);
    const rejected = await startResponse.json() as { error?: string };
    expect(rejected.error).toContain("plan sanity check failed");
    expect(rejected.error).toContain("TestFlight/EAS credentials");
    expect(readBuilderRuns(workflowId)).toHaveLength(0);
  } finally {
    if (previousEasToken === undefined) delete process.env.EAS_TOKEN;
    else process.env.EAS_TOKEN = previousEasToken;
    if (previousExpoToken === undefined) delete process.env.EXPO_TOKEN;
    else process.env.EXPO_TOKEN = previousExpoToken;
    if (previousAscKey === undefined) delete process.env.APP_STORE_CONNECT_API_KEY;
    else process.env.APP_STORE_CONNECT_API_KEY = previousAscKey;
    if (previousAscKeyPath === undefined) delete process.env.APP_STORE_CONNECT_API_KEY_PATH;
    else process.env.APP_STORE_CONNECT_API_KEY_PATH = previousAscKeyPath;
    if (previousAscPrivateKey === undefined) delete process.env.APP_STORE_CONNECT_PRIVATE_KEY;
    else process.env.APP_STORE_CONNECT_PRIVATE_KEY = previousAscPrivateKey;
  }
});

test("builder run summary includes detail-page health timeline fields", async () => {
  enableDb();
  const now = Date.now();
  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Health detail workflow",
      projectRoot: "/opt/opencode-control-surface",
      planFile: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
      mode: "once",
      status: "draft",
      config: {
        projectRoot: "/opt/opencode-control-surface",
        agentOrder: ["codex"],
        modelPolicy: { fallbackTargets: [] },
        validationProfile: { commands: ["bun run typecheck"] },
        gitPolicy: { commit: "manual", push: "never" },
        backupPolicy: { enabled: false, beforeRun: false },
        riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
      },
    }),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  const workflowId = created.data.workflow!.id;
  const db = getDashboardDb()!;
  const runId = "run_health_detail";
  const pass1 = "pass_health_1";
  const pass2 = "pass_health_2";

  db.query(`
    INSERT INTO builder_runs (id, workflow_id, trigger, status, started_at, finished_at, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(runId, workflowId, "manual", "failed", now - 20_000, now, "{}");
  db.query(`
    INSERT INTO builder_passes
      (id, run_id, workflow_id, sequence, phase, status, agent, model, started_at, finished_at,
        job_ids_json, validation_ids_json, artifact_ids_json, summary, failure_class, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pass1,
    runId,
    workflowId,
    1,
    "build",
    "failed",
    "codex",
    "gpt-5",
    now - 19_000,
    now - 12_000,
    "[]",
    "[]",
    "[]",
    "Typecheck failed",
    "validation-failed",
    "tsc failed",
  );
  db.query(`
    INSERT INTO builder_passes
      (id, run_id, workflow_id, sequence, phase, status, agent, model, started_at, finished_at,
        job_ids_json, validation_ids_json, artifact_ids_json, summary, failure_class, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pass2,
    runId,
    workflowId,
    2,
    "repair",
    "failed",
    "opencode",
    "kimi",
    now - 11_000,
    now - 1_000,
    "[]",
    "[]",
    "[]",
    "Pass timed out after no useful stdout",
    "timeout",
    "stalled with no progress",
  );
  db.query(`
    INSERT INTO builder_validations
      (id, workflow_id, run_id, pass_id, kind, status, command, started_at, finished_at, output_tail, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("val_typecheck", workflowId, runId, pass1, "typecheck", "failed", "bun run typecheck", now - 18_000, now - 17_000, "TS2322", "type error");
  db.query(`
    INSERT INTO builder_validations
      (id, workflow_id, run_id, pass_id, kind, status, command, started_at, finished_at, output_tail, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("val_preview", workflowId, runId, pass2, "preview smoke", "failed", "curl preview", now - 3_000, now - 2_000, "HTTP 500", "preview failed");
  db.query(`
    INSERT INTO builder_artifacts (id, workflow_id, run_id, pass_id, kind, path, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("artifact_dirty", workflowId, runId, pass2, "pre-pass-patch", "/tmp/pre-pass.patch", now - 10_000, JSON.stringify({ dirtyFiles: 7 }));

  const response = builderRunSummaryHandler(runId);
  expect(response.status).toBe(200);
  const envelope = await response.json() as ApiEnvelope<BuilderRunSummaryResponse>;
  const summary = envelope.data;

  expect(summary.validationFailures[0].id).toBe("val_preview");
  expect(summary.validationFailureTimeline.map((failure) => failure.id)).toEqual(["val_typecheck", "val_preview"]);
  expect(summary.validationFailureTimeline[0].passSequence).toBe(1);
  expect(summary.validationFailureTimeline[0].durationMs).toBe(1000);
  expect(summary.timeoutCount).toBe(1);
  expect(summary.stallCount).toBe(1);
  expect(summary.timeoutStallEvents[0]).toMatchObject({ passId: pass2, sequence: 2, kind: "timeout+stall" });
  expect(summary.dirtyFileCount).toBe(7);
  expect(summary.dirtyFileSnapshot).toMatchObject({ count: 7, passId: pass2, passSequence: 2, path: "/tmp/pre-pass.patch" });
  expect(summary.previewStatus.status).toBe("failed");
  expect(summary.previewStatus.label).toBe("preview smoke: failed");
});

test("builder child helpers execute disposable child and record lifecycle evidence", async () => {
  enableDb();
  const fakeBin = join(tempDir, "bin");
  mkdirSync(fakeBin, { recursive: true });
  const fakeCodex = join(fakeBin, "codex");
  writeFileSync(fakeCodex, `#!/bin/bash
set -euo pipefail
echo "fake codex invoked: $*"
if [ -n "\${BUILDER_CHILD_ID:-}" ]; then
  echo "fake child completed for $BUILDER_CHILD_ID"
fi
`, { encoding: "utf8" });
  chmodSync(fakeCodex, 0o755);
  process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;

  const body = {
    name: "Child helper smoke workflow",
    projectRoot: "/opt/opencode-control-surface",
    planFile: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
    mode: "once",
    status: "draft",
    config: {
      projectRoot: "/opt/opencode-control-surface",
      agentOrder: ["codex"],
      modelPolicy: { fallbackTargets: [] },
      validationProfile: {
        commands: ["true"],
        internalUrl: "http://127.0.0.1:3000",
        publicUrl: "https://control.techinsiderbytes.com",
      },
      gitPolicy: { commit: "manual", push: "never" },
      backupPolicy: { enabled: false, beforeRun: false },
      riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
    },
  };

  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;

  const startResponse = await builderStartWorkflowHandler(created.data.workflow!.id, new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  }));
  expect(startResponse.status).toBe(201);
  const started = await startResponse.json() as ApiEnvelope<BuilderRunResponse>;
  const run = started.data.run!;
  const scriptArtifact = started.data.artifacts.find((artifact) => artifact.kind === "command-script");
  expect(scriptArtifact).toBeTruthy();
  const builderDir = scriptArtifact!.path.replace(/\/pass-\d+\.sh$/, "");

  const smokeScript = `
set -euo pipefail
source "$BUILDER_DIR/builder-child-helpers.sh"
printf "Disposable child helper smoke for %s\\n" "$RUN_ID" > "$BUILDER_DIR/child-context.txt"
pid="$(builder_spawn_child codex fake-child-model "write harmless child output")"
echo "spawned pid=$pid"
status="$(builder_child_wait "$pid" 20)"
echo "child wait status=$status"
builder_child_output "$pid"
test "$status" = "DONE"
test -s "$BUILDER_DIR/children-manifest.jsonl"
`;
  const smoke = spawnSync("bash", ["-lc", smokeScript], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      BUILDER_DIR: builderDir,
      RUN_ID: run.id,
      BUILDER_PROJECT_ROOT: "/opt/opencode-control-surface",
      TENANT_ID: run.tenantId ?? "mimule",
    },
  });

  if (smoke.status !== 0) {
    throw new Error(`child helper smoke failed (${smoke.status})\nstdout:\n${smoke.stdout}\nstderr:\n${smoke.stderr}`);
  }
  expect(smoke.stdout).toContain("child wait status=DONE");
  expect(smoke.stdout).toContain("fake child completed");
  const manifest = readFileSync(join(builderDir, "children-manifest.jsonl"), "utf8");
  expect(manifest).toContain('"agent":"codex"');
  expect(manifest).toContain('"model":"fake-child-model"');
  const passLog = readFileSync(join(builderDir, "pass-1-stdout.log"), "utf8");
  expect(passLog).toContain("[builder-child]");

  const stopResponse = await builderStopWorkflowHandler(created.data.workflow!.id, new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  }));
  expect(stopResponse.status).toBe(200);
});

test("builder workflow start rejects tampered project roots before spawning", async () => {
  enableDb();
  const body = {
    name: "Tampered workflow",
    projectRoot: "/opt/opencode-control-surface",
    planFile: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
    mode: "once",
    status: "draft",
    config: {
      projectRoot: "/opt/opencode-control-surface",
      agentOrder: ["codex"],
      modelPolicy: { fallbackTargets: [] },
      validationProfile: {
        commands: ["bun run typecheck"],
        internalUrl: "http://127.0.0.1:3000",
        publicUrl: "https://control.techinsiderbytes.com",
      },
      gitPolicy: { commit: "manual", push: "never" },
      backupPolicy: { enabled: false, beforeRun: false },
      riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
    },
  };

  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  const workflow = created.data.workflow!;
  const workflowId = workflow.id;
  const rogueRoot = join(tempDir, "rogue-project");

  const db = getDashboardDb();
  expect(db).not.toBeNull();
  db!.query(`UPDATE builder_workflows SET config_json = ? WHERE id = ?`).run(
    JSON.stringify({ ...workflow.config, projectRoot: rogueRoot }),
    workflowId,
  );

  const startResponse = await builderStartWorkflowHandler(workflowId, new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  }));

  expect(startResponse.status).toBe(400);
  const payload = await startResponse.json() as { error?: string };
  expect(payload.error).toContain("project root is not allowlisted");
  expect(readBuilderRuns(workflowId).length).toBe(0);
});

test("builder pause and resume toggle workflow status", async () => {
  enableDb();
  const body = {
    name: "Pausable workflow",
    projectRoot: "/opt/opencode-control-surface",
    planFile: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
    mode: "once",
    status: "ready",
    config: {
      projectRoot: "/opt/opencode-control-surface",
      agentOrder: ["codex"],
      modelPolicy: { fallbackTargets: [] },
      validationProfile: {
        commands: ["bun run typecheck"],
        internalUrl: "http://127.0.0.1:3000",
        publicUrl: "https://control.techinsiderbytes.com",
      },
      gitPolicy: { commit: "manual", push: "never" },
      backupPolicy: { enabled: false, beforeRun: false },
      riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
    },
  };

  const createResponse = await builderCreateWorkflowHandler(new Request("http://localhost/api/builder/workflows", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<BuilderWorkflowResponse>;
  const workflowId = created.data.workflow!.id;

  const pauseResponse = await builderPauseWorkflowHandler(workflowId);
  expect(pauseResponse.status).toBe(200);
  let wf = readBuilderWorkflow(workflowId);
  expect(wf!.status).toBe("paused");

  const resumeResponse = await builderResumeWorkflowHandler(workflowId);
  expect(resumeResponse.status).toBe(200);
  wf = readBuilderWorkflow(workflowId);
  expect(wf!.status).toBe("ready");
});
