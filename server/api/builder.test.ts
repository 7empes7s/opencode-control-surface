import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { readActionAudit } from "../db/writer.ts";
import type { ApiEnvelope } from "./types.ts";
import {
  builderCreateWorkflowHandler,
  builderDiscoverHandler,
  builderModelsHandler,
  builderPauseWorkflowHandler,
  builderProjectsHandler,
  builderRunHandler,
  builderResumeWorkflowHandler,
  builderRunnerDisabledHandler,
  builderStartWorkflowHandler,
  builderStopWorkflowHandler,
  builderWorkflowsHandler,
  type BuilderProjectsResponse,
  type BuilderRunResponse,
  type BuilderWorkflowResponse,
  type BuilderWorkflowsResponse,
} from "./builder.ts";
import type { BuilderDiscovery, BuilderModelsInventory } from "../builder/discovery.ts";
import { readBuilderRuns, readBuilderWorkflow } from "../builder/store.ts";
import { selectModelForRole } from "../builder/modelSelector.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "builder-api-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
});

afterEach(() => {
  closeDashboardDb();
  if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDashboardDb;
  if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
  rmSync(tempDir, { recursive: true, force: true });
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
      riskPolicy: { liveDeploys: "disabled", maxPasses: 1 },
      sourceSession: {
        agent: "codex",
        sessionId: "cdx_test",
        title: "Dashboard chat handoff",
        directory: "/opt/opencode-control-surface",
        messageCount: 3,
        capturedAt: "2026-05-14T00:00:00.000Z",
        transcriptSummary: "Started: continue Dashboard V4\nTouched files: app/routes/BuilderPage.tsx",
        latestUserPrompt: "Continue development from the current session.",
        touchedFiles: ["app/routes/BuilderPage.tsx", "server/api/builder.ts"],
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
  expect(created.data.workflow?.config.validationProfile.commands).toContain("bun run build");
  expect(created.data.workflow?.config.sourceSession?.agent).toBe("codex");
  expect(created.data.workflow?.config.sourceSession?.sessionId).toBe("cdx_test");
  expect(created.data.workflow?.config.sourceSession?.transcriptSummary).toContain("Dashboard V4");
  expect(created.data.workflow?.config.sourceSession?.latestUserPrompt).toContain("Continue development");
  expect(created.data.workflow?.config.sourceSession?.touchedFiles).toContain("server/api/builder.ts");

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

test("builder runner mutations are explicitly disabled until phase three", async () => {
  const response = builderRunnerDisabledHandler("start");
  expect(response.status).toBe(409);
  const payload = await response.json() as { status: string; action: string };
  expect(payload.status).toBe("disabled");
  expect(payload.action).toBe("start");
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
