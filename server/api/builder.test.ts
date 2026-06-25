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
  builderProjectsHandler,
  builderRunHandler,
  builderResumeWorkflowHandler,
  builderRunnerDisabledHandler,
  builderStartWorkflowHandler,
  builderStopWorkflowHandler,
  builderWorkflowsHandler,
  type BuilderProvisionResponse,
  type BuilderProjectsResponse,
  type BuilderRunResponse,
  type BuilderWorkflowResponse,
  type BuilderWorkflowsResponse,
} from "./builder.ts";
import type { BuilderDiscovery, BuilderModelsInventory } from "../builder/discovery.ts";
import { readBuilderRuns, readBuilderWorkflow } from "../builder/store.ts";
import { selectModelForRole } from "../builder/modelSelector.ts";
import { getValidationProfileStartBlockers } from "../builder/validation-profile.ts";

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
