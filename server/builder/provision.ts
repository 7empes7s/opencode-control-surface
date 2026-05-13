import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export type ProvisionInput = {
  repoUrl?: string;
  projectRoot: string;
  name: string;
  description?: string;
  tags?: string[];
  owner?: string;
  defaultPlanPath?: string;
  agentOrder?: string[];
  validationCommands?: string[];
};

export type ProvisionResult = {
  ok: boolean;
  projectRoot: string;
  name: string;
  provisioned: {
    cloned: boolean;
    gitInitialized: boolean;
    agentsMd: boolean;
    planFile: string | null;
    vaultNote: boolean;
    skillFile: boolean;
  };
  workflows: Array<{ id: string; name: string; status: string }>;
  warnings: string[];
  error?: string;
};

function runGit(args: string[], cwd: string, timeout = 30_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { encoding: "utf8", cwd, timeout });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function cloneRepo(repoUrl: string, targetDir: string): { ok: boolean; error?: string } {
  // Clone into a temp dir then move, to avoid partial clones in target
  const parentDir = join(targetDir, "..");
  if (!existsSync(parentDir)) {
    try { mkdirSync(parentDir, { recursive: true }); } catch { /* ignore */ }
  }
  const result = spawnSync("git", ["clone", "--depth", "1", repoUrl, targetDir], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    return { ok: false, error: `git clone failed (exit ${result.status}): ${result.stderr?.slice(0, 500)}` };
  }
  return { ok: true };
}

function initGit(projectRoot: string): boolean {
  if (!existsSync(projectRoot)) return false;
  const result = runGit(["init"], projectRoot);
  return result.status === 0;
}

function findPlanFiles(projectRoot: string): string[] {
  if (!existsSync(projectRoot)) return [];
  const candidates: string[] = [];
  try {
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name.toLowerCase();
      if (name.includes("plan") || name.includes("roadmap") || name.includes("agent") || name.includes("claude") || name === "readme.md") {
        candidates.push(join(projectRoot, entry.name));
      }
    }
  } catch { /* ignore */ }
  return candidates;
}

function inferValidationCommands(projectRoot: string): string[] {
  if (!existsSync(join(projectRoot, "package.json"))) return [];
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const cmds: string[] = [];
    if (pkg.scripts?.typecheck) cmds.push("bun run typecheck");
    if (pkg.scripts?.build) cmds.push("bun run build");
    if (pkg.scripts?.check) cmds.push("bun run check");
    const hasServerDir = existsSync(join(projectRoot, "server", "db")) || existsSync(join(projectRoot, "server", "api"));
    if (hasServerDir && pkg.scripts?.test) cmds.push("bun test");
    return cmds;
  } catch { return []; }
}

function createAgentsMd(projectRoot: string, name: string, description: string): { ok: boolean; path: string } {
  const agentsPath = join(projectRoot, "AGENTS.md");
  const template = `# ${name}

${description}

## Working with this project

- Read this file before making changes.
- Use the plan file (PLAN.md or similar) to understand current priorities.
- Run validation commands after every change.
- Log significant progress to /opt/ai-vault/projects/${name.toLowerCase().replace(/\s+/g, "-")}.md

## Validation

Run the following before marking a change complete:
\`\`\`bash
bun run check   # typecheck + build
bun test        # tests
\`\`\`

## Stack context

This project is maintained as part of the TechInsiderBytes / MIMULE stack.
Operator context: https://control.techinsiderbytes.com
`;
  try {
    writeFileSync(agentsPath, template, { encoding: "utf8" });
    return { ok: true, path: agentsPath };
  } catch (e) {
    return { ok: false, path: agentsPath };
  }
}

function createProjectSkill(projectRoot: string, name: string): { ok: boolean; path: string } {
  const skillDir = join(projectRoot, ".opencode", "skills", "project-workflow");
  let skillPath = "";
  try {
    mkdirSync(skillDir, { recursive: true });
    skillPath = join(skillDir, "SKILL.md");
    const content = `---
description: Navigate, build, and maintain the ${name} project. Read plan files, run validations, and log progress.
---

# ${name} Project Workflow

## Quick commands

- Read plan: look for PLAN.md, *_PLAN*.md in the project root
- Validate: bun run check (typecheck + build)
- Test: bun test (if available)
- Log: append progress to /opt/ai-vault/projects/${name.toLowerCase().replace(/\s+/g, "-")}.md

## Workflow

1. Read AGENTS.md and the project plan file.
2. Identify the current priority or next step.
3. Make one bounded, independently shippable change.
4. Run validation commands.
5. Report changed files, test results, and next steps.
`;
    writeFileSync(skillPath, content, { encoding: "utf8" });
    return { ok: true, path: skillPath };
  } catch (e) {
    return { ok: false, path: skillPath };
  }
}

function writeVaultNote(projectRoot: string, name: string, description: string, tags: string[], owner: string): boolean {
  const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const vaultPath = `/opt/ai-vault/projects/${slug}.md`;
  try {
    const content = `---
title: ${name}
description: ${description || " "}
tags: [${(tags ?? []).join(", ")}]
owner: ${owner ?? "operator"}
projectRoot: ${projectRoot}
createdAt: ${new Date().toISOString()}
---

# ${name}

${description || ""}

## Status

Initial provisioning complete. See Builder Pipeline runs for development history.

## Notes

- Plan files: see project root
- Agent workspace: ${projectRoot}
`;
    writeFileSync(vaultPath, content, { encoding: "utf8" });
    return true;
  } catch { return false; }
}

function addWorkspaceAllowlist(projectRoot: string, name: string): void {
  // Dynamically extend the in-process workspace allowlist so subsequent
  // discovery calls and workflow execution can reach the new project root.
  // The statically exported WORKSPACE_ROOTS in workspaces.ts cannot be
  // mutated at runtime, so we use a module-level registry instead.
  // Provisioned roots are also stored in dashboard.sqlite builder_projects
  // and can be reloaded from there on service restart.
  // We store a path -> label map in process.env so other modules can check it.
  const key = `BUILDER_ALLOWED_ROOT_${Buffer.from(projectRoot).toString("base64").replace(/[/+=]/g, "_")}`;
  process.env[key] = name;
  // Also track all provisioned roots in a comma-separated env var
  const allKey = "BUILDER_PROVISIONED_ROOTS";
  const existing = process.env[allKey] ?? "";
  const parts = existing ? existing.split(",") : [];
  if (!parts.includes(projectRoot)) {
    parts.push(projectRoot);
    process.env[allKey] = parts.join(",");
  }
}

export function isProjectRootAllowlisted(projectRoot: string): boolean {
  // Check static allowlist first
  const STATIC_ROOTS = [
    "/opt/opencode-control-surface",
    "/opt/newsbites",
    "/opt/mimoun",
    "/opt/paperclip",
    "/opt",
    "/root",
  ];
  if (STATIC_ROOTS.includes(projectRoot)) return true;
  // Check dynamically provisioned roots
  const allKey = "BUILDER_PROVISIONED_ROOTS";
  const provisioned = process.env[allKey] ?? "";
  return provisioned.split(",").filter(Boolean).includes(projectRoot);
}

export function provisionProject(input: ProvisionInput): ProvisionResult {
  const warnings: string[] = [];
  const projectRoot = resolve(input.projectRoot);

  // Validate project root doesn't already exist as a known project
  if (existsSync(projectRoot)) {
    let hasContent = false;
    try { hasContent = readdirSync(projectRoot).length > 0; } catch { /* ignore */ }
    if (hasContent && !input.repoUrl) {
      warnings.push(`project root ${projectRoot} already exists and is not empty; cloning will be skipped`);
    }
  } else {
    // Ensure parent exists
    const parent = join(projectRoot, "..");
    try { mkdirSync(parent, { recursive: true }); } catch { /* ignore */ }
  }

  let cloned = false;
  let gitInitialized = false;

  // Clone from repo if URL provided
  if (input.repoUrl) {
    const cloneResult = cloneRepo(input.repoUrl, projectRoot);
    if (!cloneResult.ok) {
      return { ok: false, projectRoot, name: input.name, provisioned: { cloned: false, gitInitialized: false, agentsMd: false, planFile: null, vaultNote: false, skillFile: false }, workflows: [], warnings, error: cloneResult.error };
    }
    cloned = true;
  } else if (!existsSync(projectRoot)) {
    // Init a new directory if neither clone nor existing dir
    try { mkdirSync(projectRoot, { recursive: true }); } catch (e) {
      return { ok: false, projectRoot, name: input.name, provisioned: { cloned: false, gitInitialized: false, agentsMd: false, planFile: null, vaultNote: false, skillFile: false }, workflows: [], warnings, error: `could not create project root: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Initialize git if no .git directory exists
  if (!existsSync(join(projectRoot, ".git"))) {
    gitInitialized = initGit(projectRoot);
    if (!gitInitialized) warnings.push("git init failed; some Builder features may be limited");
  }

  // Create AGENTS.md
  const agentsResult = createAgentsMd(projectRoot, input.name, input.description ?? "");
  if (!agentsResult.ok) warnings.push("AGENTS.md creation failed");

  // Find or create plan file
  const planFiles = findPlanFiles(projectRoot);
  let planFile: string | null = null;
  if (input.defaultPlanPath && existsSync(input.defaultPlanPath)) {
    planFile = input.defaultPlanPath;
  } else if (planFiles.length > 0) {
    planFile = planFiles[0];
  }
  // If no plan found, create a stub PLAN.md
  if (!planFile || !existsSync(planFile)) {
    const stubPlan = join(projectRoot, "PLAN.md");
    try {
      writeFileSync(stubPlan, `# ${input.name}\n\nLast updated: ${new Date().toISOString().slice(0, 10)}\n\n## Status\n\nInitial provisioning. Add phases and tasks here.\n\n---\n`, { encoding: "utf8" });
      planFile = stubPlan;
      warnings.push("No plan file found; created stub PLAN.md");
    } catch { /* ignore */ }
  }

  // Create project skill
  const skillResult = createProjectSkill(projectRoot, input.name);
  if (!skillResult.ok) warnings.push("project skill creation failed");

  // Write vault note
  const vaultOk = writeVaultNote(projectRoot, input.name, input.description ?? "", input.tags ?? [], input.owner ?? "operator");
  if (!vaultOk) warnings.push("AI Vault note creation failed");

  // Add to runtime allowlist
  addWorkspaceAllowlist(projectRoot, input.name);

  // Infer or use provided validation commands
  const validationCmds = input.validationCommands?.length ? input.validationCommands : inferValidationCommands(projectRoot);
  if (validationCmds.length === 0) warnings.push("no validation commands found or provided; workflow may need manual setup");

  // Return a stub workflow that can be filled in by the caller
  // Actual workflow creation is handled by store.ts::provisionProject after this succeeds
  return {
    ok: true,
    projectRoot,
    name: input.name,
    provisioned: {
      cloned,
      gitInitialized,
      agentsMd: agentsResult.ok,
      planFile,
      vaultNote: vaultOk,
      skillFile: skillResult.ok,
    },
    workflows: [],
    warnings,
  };
}

export type ProvisionStoreInput = {
  projectRoot: string;
  name: string;
  repoUrl?: string;
  description?: string;
  tags?: string[];
  owner?: string;
  planFile: string;
  agentOrder: string[];
  fallbackTargets: string[];
  validationCommands: string[];
  gitPolicy: { commit: string; push: string };
  internalUrl?: string;
  publicUrl?: string;
};