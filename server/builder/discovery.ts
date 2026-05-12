import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { getModelsDetail } from "../adapters/models.ts";
import { WORKSPACE_ROOTS, normalizeWorkspace, type WorkspaceRisk } from "../api/workspaces.ts";

type DiscoveryStatus = "ok" | "missing" | "degraded" | "error";

export type BuilderProject = {
  root: string;
  label: string;
  risk: WorkspaceRisk;
  writable: boolean;
  note: string;
  service?: string;
  internalUrl?: string;
  publicUrl?: string;
  defaultPlan?: string;
};

export type BuilderPlanCandidate = {
  path: string;
  title: string;
  kind: "canonical" | "builder" | "project" | "context";
  exists: boolean;
  modifiedAt: number | null;
  relevance: string;
};

export type BuilderSkillStatus = {
  name: string;
  path: string;
  status: DiscoveryStatus;
  description: string;
  modifiedAt: number | null;
};

export type BuilderGitSummary = {
  root: string | null;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  changed: number;
  untracked: number;
  statusLines: string[];
  status: DiscoveryStatus;
  evidence: string;
};

export type BuilderValidationProfile = {
  name: string;
  packageManager: "bun" | "npm" | "unknown";
  commands: string[];
  inferredFrom: string[];
  status: DiscoveryStatus;
};

export type BuilderDiscovery = {
  project: BuilderProject;
  generatedAt: string;
  planCandidates: BuilderPlanCandidate[];
  skills: BuilderSkillStatus[];
  git: BuilderGitSummary;
  validation: BuilderValidationProfile;
  urls: {
    internal: string | null;
    public: string | null;
    health: string | null;
  };
  agents: {
    codex: DiscoveryStatus;
    claude: DiscoveryStatus;
    opencode: DiscoveryStatus;
    evidence: Record<string, string>;
  };
  models: BuilderModelsInventory;
  missingPrerequisites: string[];
};

export type BuilderModelsInventory = {
  bestLocal: string | null;
  bestCloudHeavy: string | null;
  bestCloudFast: string | null;
  available: number;
  blocked: number;
  fallbackTargets: string[];
  sample: string[];
};

const PROJECT_TARGETS: Record<string, Partial<BuilderProject>> = {
  "/opt/opencode-control-surface": {
    service: "control-surface.service",
    internalUrl: "http://127.0.0.1:3000",
    publicUrl: "https://control.techinsiderbytes.com",
    defaultPlan: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
  },
  "/opt/newsbites": {
    service: "newsbites.service",
    internalUrl: "http://127.0.0.1:3001",
    publicUrl: "https://news.techinsiderbytes.com",
  },
  "/opt/paperclip": {
    internalUrl: "http://127.0.0.1:3100",
    publicUrl: "https://paperclip.techinsiderbytes.com",
  },
  "/opt/mimoun": {
    internalUrl: "http://127.0.0.1:18789",
    publicUrl: "https://mimoun.techinsiderbytes.com",
  },
};

const KNOWN_PLAN_FILES: Array<Omit<BuilderPlanCandidate, "exists" | "modifiedAt" | "title"> & { title?: string }> = [
  {
    path: "/root/DASHBOARD_V4_PLAN.md",
    kind: "canonical",
    relevance: "Dashboard V4 canonical implementation plan.",
  },
  {
    path: "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
    kind: "builder",
    relevance: "Builder Pipeline phase plan and API/UI specification.",
  },
  {
    path: "/root/DASHBOARD_V4_AGENT_PAGES_PLAN.md",
    kind: "context",
    relevance: "Agent page roadmap that intersects with Builder execution.",
  },
  {
    path: "/home/agent/MIMULE_MASTER_PLAN_V3.md",
    kind: "context",
    relevance: "Canonical stack continuation and progress log.",
  },
  {
    path: "/root/CLAUDE.md",
    kind: "context",
    relevance: "Workspace and service operating context.",
  },
];

const DASHBOARD_ORCHESTRATOR_SKILL = "/root/.codex/skills/dashboard-orchestrator/SKILL.md";

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function readTitle(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    const heading = text.split(/\r?\n/).find((line) => line.startsWith("# "));
    if (heading) return heading.replace(/^#\s+/, "").trim();
  } catch {}
  return basename(path);
}

function fileModifiedAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function commandStatus(command: string, args: string[], cwd?: string): { status: DiscoveryStatus; output: string } {
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.error) return { status: "error", output: result.error.message };
    if (result.status === 0) return { status: "ok", output: output.slice(0, 800) };
    return { status: "degraded", output: output.slice(0, 800) || `exit ${result.status}` };
  } catch (error) {
    return { status: "error", output: error instanceof Error ? error.message : String(error) };
  }
}

function parseSkillDescription(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
    const description = frontmatter?.[1]
      .split(/\r?\n/)
      .find((line) => line.startsWith("description:"))
      ?.replace(/^description:\s*/, "")
      .trim();
    return description || "Dashboard V4 orchestration workflow.";
  } catch {
    return "";
  }
}

function projectFromRoot(root: string): BuilderProject | null {
  const workspace = WORKSPACE_ROOTS.find((entry) => entry.path === root);
  if (!workspace) return null;
  return {
    root: workspace.path,
    label: workspace.label,
    risk: workspace.risk,
    writable: workspace.writable,
    note: workspace.note,
    ...PROJECT_TARGETS[workspace.path],
  };
}

export function getBuilderProjects(): BuilderProject[] {
  return WORKSPACE_ROOTS
    .filter((entry) => existsSync(entry.path))
    .map((entry) => ({
      root: entry.path,
      label: entry.label,
      risk: entry.risk,
      writable: entry.writable,
      note: entry.note,
      ...PROJECT_TARGETS[entry.path],
    }));
}

function findProjectForPath(path: string): BuilderProject | null {
  const resolved = resolve(path);
  const exact = projectFromRoot(resolved);
  if (exact) return exact;
  return getBuilderProjects().find((project) => isWithin(resolved, project.root)) ?? null;
}

function scanProjectPlanFiles(projectRoot: string): BuilderPlanCandidate[] {
  const candidates: BuilderPlanCandidate[] = [];
  if (!existsSync(projectRoot)) return candidates;

  try {
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (!/(PLAN|ROADMAP|AGENT|CLAUDE|README)/i.test(entry.name)) continue;
      const path = join(projectRoot, entry.name);
      candidates.push({
        path,
        title: readTitle(path),
        kind: "project",
        exists: true,
        modifiedAt: fileModifiedAt(path),
        relevance: "Project-local planning or operating document.",
      });
    }
  } catch {}

  return candidates;
}

function discoverPlanCandidates(projectRoot: string): BuilderPlanCandidate[] {
  const known = KNOWN_PLAN_FILES.map((candidate) => ({
    ...candidate,
    title: candidate.title ?? readTitle(candidate.path),
    exists: existsSync(candidate.path),
    modifiedAt: fileModifiedAt(candidate.path),
  }));
  const project = scanProjectPlanFiles(projectRoot);
  const byPath = new Map<string, BuilderPlanCandidate>();

  for (const item of [...known, ...project]) {
    byPath.set(item.path, item);
  }

  return Array.from(byPath.values()).sort((a, b) => {
    const rank = { builder: 0, canonical: 1, project: 2, context: 3 } as const;
    return rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path);
  });
}

function discoverSkills(): BuilderSkillStatus[] {
  return [
    {
      name: "dashboard-orchestrator",
      path: DASHBOARD_ORCHESTRATOR_SKILL,
      status: existsSync(DASHBOARD_ORCHESTRATOR_SKILL) ? "ok" : "missing",
      description: parseSkillDescription(DASHBOARD_ORCHESTRATOR_SKILL),
      modifiedAt: fileModifiedAt(DASHBOARD_ORCHESTRATOR_SKILL),
    },
  ];
}

function summarizeGit(projectRoot: string): BuilderGitSummary {
  const rootResult = commandStatus("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"]);
  if (rootResult.status !== "ok") {
    return {
      root: null,
      branch: null,
      head: null,
      dirty: false,
      changed: 0,
      untracked: 0,
      statusLines: [],
      status: rootResult.status,
      evidence: rootResult.output || "not a git repository",
    };
  }

  const gitRoot = rootResult.output.split(/\r?\n/)[0]?.trim() || projectRoot;
  const branch = commandStatus("git", ["-C", projectRoot, "branch", "--show-current"]);
  const head = commandStatus("git", ["-C", projectRoot, "rev-parse", "--short", "HEAD"]);
  const status = commandStatus("git", ["-C", projectRoot, "status", "--short"]);
  const lines = status.output.split(/\r?\n/).filter(Boolean);

  return {
    root: gitRoot,
    branch: branch.status === "ok" ? branch.output.split(/\r?\n/)[0] || null : null,
    head: head.status === "ok" ? head.output.split(/\r?\n/)[0] || null : null,
    dirty: lines.length > 0,
    changed: lines.filter((line) => !line.startsWith("??")).length,
    untracked: lines.filter((line) => line.startsWith("??")).length,
    statusLines: lines.slice(0, 80),
    status: status.status,
    evidence: lines.length > 0 ? `${lines.length} status entries` : "clean worktree",
  };
}

function inferValidationProfile(projectRoot: string): BuilderValidationProfile {
  const packageJsonPath = join(projectRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return {
      name: "manual",
      packageManager: "unknown",
      commands: [],
      inferredFrom: [],
      status: "missing",
    };
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const commands: string[] = [];
    const inferredFrom = [packageJsonPath];
    if (scripts.typecheck) commands.push("bun run typecheck");
    if (scripts.build) commands.push("bun run build");
    if (existsSync(join(projectRoot, "server", "db")) || existsSync(join(projectRoot, "server", "api"))) {
      commands.push("bun test server/db/ server/api/");
    } else if (scripts.test) {
      commands.push("bun test");
    }
    if (scripts.check && commands.length === 0) commands.push("bun run check");

    return {
      name: "project package validation",
      packageManager: existsSync(join(projectRoot, "bun.lock")) ? "bun" : "npm",
      commands,
      inferredFrom,
      status: commands.length > 0 ? "ok" : "degraded",
    };
  } catch (error) {
    return {
      name: "package parse failed",
      packageManager: "unknown",
      commands: [],
      inferredFrom: [packageJsonPath],
      status: "error",
    };
  }
}

function discoverAgents(): BuilderDiscovery["agents"] {
  const bins = {
    codex: commandStatus("codex", ["--version"]),
    claude: commandStatus("claude", ["--version"]),
    opencode: commandStatus("opencode", ["--version"]),
  };
  return {
    codex: bins.codex.status,
    claude: bins.claude.status,
    opencode: bins.opencode.status,
    evidence: {
      codex: bins.codex.output,
      claude: bins.claude.output,
      opencode: bins.opencode.output,
    },
  };
}

export function getBuilderModelsInventory(): BuilderModelsInventory {
  const detail = getModelsDetail();
  const fallbackTargets = Object.keys(detail.fallbacks).sort();
  const availableModels = detail.models.filter((model) => model.available);
  return {
    bestLocal: detail.summary.bestLocal,
    bestCloudHeavy: detail.summary.bestCloudHeavy,
    bestCloudFast: detail.summary.bestCloudFast,
    available: availableModels.length,
    blocked: detail.summary.qualitySummary.blocked,
    fallbackTargets,
    sample: availableModels.slice(0, 8).map((model) => model.logicalName),
  };
}

export function discoverBuilderProject(rootInput: string): { ok: true; data: BuilderDiscovery } | { ok: false; error: string } {
  const normalized = normalizeWorkspace(rootInput);
  if (normalized.ok === false) return { ok: false, error: normalized.error };
  const project = findProjectForPath(normalized.path);
  if (!project) {
    return { ok: false, error: `no builder project registered for ${normalized.path}` };
  }

  const planCandidates = discoverPlanCandidates(project.root);
  const skills = discoverSkills();
  const git = summarizeGit(project.root);
  const validation = inferValidationProfile(project.root);
  const agents = discoverAgents();
  const models = getBuilderModelsInventory();

  const missingPrerequisites = [
    !planCandidates.some((candidate) => candidate.path === "/root/DASHBOARD_V4_PLAN.md" && candidate.exists)
      ? "/root/DASHBOARD_V4_PLAN.md"
      : null,
    !skills.some((skill) => skill.name === "dashboard-orchestrator" && skill.status === "ok")
      ? "dashboard-orchestrator skill"
      : null,
    validation.commands.length === 0 ? "validation commands" : null,
    git.status !== "ok" ? "git repository" : null,
    !project.internalUrl ? "internal URL target" : null,
    agents.codex !== "ok" && agents.claude !== "ok" && agents.opencode !== "ok" ? "agent CLI" : null,
  ].filter(Boolean) as string[];

  return {
    ok: true,
    data: {
      project,
      generatedAt: new Date().toISOString(),
      planCandidates,
      skills,
      git,
      validation,
      urls: {
        internal: project.internalUrl ?? null,
        public: project.publicUrl ?? null,
        health: project.internalUrl ? `${project.internalUrl}/health` : null,
      },
      agents,
      models,
      missingPrerequisites,
    },
  };
}
