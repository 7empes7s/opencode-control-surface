import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { WORKSPACE_ROOTS } from "./workspaces.ts";

type AgentId = "claude" | "codex" | "opencode" | "gemini";
type DiscoveryStatus = "ok" | "missing" | "degraded" | "error";

type SkillItem = {
  id: string;
  name: string;
  description: string;
  source: string;
  sourcePath: string;
  modifiedAt: number;
  agents: AgentId[];
};

type CommandItem = {
  id: string;
  name: string;
  description: string;
  source: string;
  agents: AgentId[];
  sourcePath?: string;
  modifiedAt?: number;
};

type QuickPromptRisk = "low" | "medium" | "high";

type QuickPromptItem = {
  id: string;
  name: string;
  description: string;
  source: string;
  sourcePath?: string;
  modifiedAt?: number;
  agents: AgentId[];
  targetRoots: string[];
  insertText: string;
  risk: QuickPromptRisk;
  priority: number;
};

type ProbeResult = {
  status: DiscoveryStatus;
  evidence: string;
  code?: number;
  stdout?: string;
  stderr?: string;
};

type DiscoveryData = {
  skills: SkillItem[];
  commands: CommandItem[];
  sources: Record<string, { status: DiscoveryStatus; path?: string; evidence: string; count?: number }>;
  cli: Record<AgentId, ProbeResult>;
  mcp: Record<AgentId, ProbeResult>;
  runtime: {
    claudeSessions: { count: number; latestUpdatedAt: number | null };
    codexSessions: { count: number; latestUpdatedAt: number | null };
    opencodeSessions: { count: number; items: unknown[]; status: DiscoveryStatus; evidence: string };
    opencodeAgents: { count: number; names: string[]; status: DiscoveryStatus; evidence: string };
    opencodeModels: { sample: string[]; status: DiscoveryStatus; evidence: string };
    opencodeStats: { sample: string[]; status: DiscoveryStatus; evidence: string };
    geminiSessions: { count: number; latestUpdatedAt: number | null };
    modelHealth: { status: DiscoveryStatus; path: string; updatedAt: number | null; bestCloudHeavy?: string; bestCloudFast?: string };
    gpuHealth: { status: DiscoveryStatus; path: string; updatedAt: number | null };
  };
  duplicates: { name: string; count: number; paths: string[] }[];
};

const STATE_DIR = "/var/lib/control-surface";
const CLAUDE_STATE = join(STATE_DIR, "claude-sessions.json");
const CODEX_STATE = join(STATE_DIR, "codex-sessions.json");
const GEMINI_STATE = join(STATE_DIR, "gemini-sessions.json");
const MODEL_HEALTH = "/var/lib/mimule/model-health.json";
const GPU_HEALTH = "/var/lib/mimule/gpu-health.json";
const CLAUDE_BIN = "/root/.local/bin/claude";
const CODEX_BIN = "/usr/bin/codex";
const OPENCODE_BIN = "/root/.opencode/bin/opencode";
const GEMINI_BIN = "/usr/bin/gemini";
const QUICK_PROMPTS_FILE = "/opt/opencode-control-surface/config/agent-quick-prompts.json";
const OPERATOR_QUICK_PROMPTS_FILE = join(STATE_DIR, "agent-quick-prompts.json");
const DAILY_VAULT_DIR = "/opt/ai-vault/daily";
const DASHBOARD_PROJECT_NOTE = "/opt/ai-vault/projects/2026-05-07-dashboard-v3-redesign.md";
const MASTER_PLAN = "/home/agent/MIMULE_MASTER_PLAN_V3.md";

const ALL_AGENTS: AgentId[] = ["claude", "codex", "opencode", "gemini"];

const SKILL_SOURCES: Array<{
  id: string;
  label: string;
  path: string;
  agents: AgentId[];
  mode: "children" | "file" | "recursive";
}> = [
  { id: "claude-user-skills", label: "Claude user skills", path: "/root/.claude/skills", agents: ALL_AGENTS, mode: "children" },
  { id: "codex-user-skills", label: "Codex user skills", path: "/root/.codex/skills", agents: ALL_AGENTS, mode: "children" },
  { id: "shared-user-skills", label: "Shared user skills", path: "/root/.agents/skills", agents: ALL_AGENTS, mode: "children" },
  { id: "opencode-project-skills", label: "OpenCode project skills", path: "/opt/opencode-control-surface/.opencode/skills", agents: ALL_AGENTS, mode: "children" },
  { id: "opencode-root-skill", label: "OpenCode root skill", path: "/opt/opencode-control-surface/.opencode/SKILL.md", agents: ALL_AGENTS, mode: "file" },
  { id: "codex-plugin-skills", label: "Codex plugin skills", path: "/root/.codex/plugins/cache", agents: ALL_AGENTS, mode: "recursive" },
  { id: "claude-plugin-skills", label: "Claude plugin skills", path: "/root/.claude/plugins/cache", agents: ALL_AGENTS, mode: "recursive" },
];

const COMMAND_SOURCES: Array<{
  id: string;
  label: string;
  path: string;
  agents: AgentId[];
}> = [
  { id: "claude-user-commands", label: "Claude user commands", path: "/root/.claude/commands", agents: ALL_AGENTS },
  { id: "claude-plugin-commands", label: "Claude plugin commands", path: "/root/.claude/plugins/cache", agents: ALL_AGENTS },
];

let discoveryCache: { at: number; data: DiscoveryData } | null = null;
const CACHE_MS = 30_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sanitize(text: string, limit = 4000): string {
  return text
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-token]")
    .replace(/(token|key|secret|password)=\S+/gi, "$1=[redacted]")
    .slice(0, limit);
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    fields[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

function firstDescription(markdown: string): string {
  const withoutFrontmatter = markdown.replace(/^---\n[\s\S]*?\n---/, "").trim();
  for (const raw of withoutFrontmatter.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    return line.slice(0, 240);
  }
  return "";
}

function skillFromFile(path: string, source: string, agents: AgentId[]): SkillItem | null {
  try {
    const md = readFileSync(path, "utf8");
    const fm = parseFrontmatter(md);
    const folder = basename(dirname(path));
    const name = fm.name || (basename(path) === "SKILL.md" ? folder : basename(path, ".md"));
    const st = statSync(path);
    return {
      id: `${source}:${name}:${path}`,
      name,
      description: fm.description || firstDescription(md) || "No description provided.",
      source,
      sourcePath: path,
      modifiedAt: st.mtimeMs,
      agents,
    };
  } catch {
    return null;
  }
}

function listSkillFiles(source: (typeof SKILL_SOURCES)[number]): { files: string[]; status: DiscoveryStatus; evidence: string } {
  if (!existsSync(source.path)) {
    return { files: [], status: "missing", evidence: "source path does not exist" };
  }

  try {
    if (source.mode === "file") {
      return { files: [source.path], status: "ok", evidence: "file present" };
    }

    if (source.mode === "children") {
      const files = readdirSync(source.path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(source.path, entry.name, "SKILL.md"))
        .filter((path) => existsSync(path));
      return { files, status: "ok", evidence: `${files.length} skill files found` };
    }

    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && entry.name === "SKILL.md") files.push(full);
      }
    };
    walk(source.path, 0);
    return { files, status: "ok", evidence: `${files.length} skill files found recursively` };
  } catch (e) {
    return { files: [], status: "error", evidence: e instanceof Error ? e.message : String(e) };
  }
}

function scanSkills(): { skills: SkillItem[]; sources: DiscoveryData["sources"] } {
  const skills: SkillItem[] = [];
  const sources: DiscoveryData["sources"] = {};

  for (const source of SKILL_SOURCES) {
    const listed = listSkillFiles(source);
    sources[source.id] = {
      status: listed.status,
      path: source.path,
      evidence: listed.evidence,
      count: listed.files.length,
    };
    for (const file of listed.files) {
      const item = skillFromFile(file, source.label, source.agents);
      if (item) skills.push(item);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath));
  return { skills, sources };
}

function markdownCommandFromFile(path: string, source: string, agents: AgentId[]): CommandItem | null {
  try {
    const md = readFileSync(path, "utf8");
    const fm = parseFrontmatter(md);
    const name = fm.name || basename(path, ".md");
    const st = statSync(path);
    return {
      id: `${source}:${name}:${path}`,
      name,
      description: fm.description || firstDescription(md) || "Project command.",
      source,
      sourcePath: path,
      modifiedAt: st.mtimeMs,
      agents,
    };
  } catch {
    return null;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function workspaceRootFor(cwd: string | null): string | null {
  if (!cwd) return null;
  const candidate = resolve(cwd);
  const roots = WORKSPACE_ROOTS
    .map((root) => root.path)
    .sort((a, b) => b.length - a.length);
  return roots.find((root) => isWithin(candidate, resolve(root))) ?? null;
}

function normalizeAgents(value: unknown): AgentId[] {
  if (!Array.isArray(value)) return ALL_AGENTS;
  const agents = value.filter((item): item is AgentId =>
    item === "claude" || item === "codex" || item === "opencode" || item === "gemini");
  return agents.length > 0 ? agents : ALL_AGENTS;
}

function normalizePrompt(raw: unknown, source: string, sourcePath: string, modifiedAt?: number): QuickPromptItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const insertText = typeof item.insertText === "string" ? item.insertText.trim() : "";
  if (!id || !name || !insertText) return null;

  const targetRoots = Array.isArray(item.targetRoots)
    ? item.targetRoots.filter((root): root is string => typeof root === "string" && root.startsWith("/"))
    : [];
  const risk = item.risk === "low" || item.risk === "medium" || item.risk === "high"
    ? item.risk
    : "medium";
  const priority = typeof item.priority === "number" && Number.isFinite(item.priority)
    ? item.priority
    : 0;

  return {
    id,
    name,
    description: typeof item.description === "string" && item.description.trim()
      ? item.description.trim()
      : "Workspace quick prompt.",
    source,
    sourcePath,
    modifiedAt,
    agents: normalizeAgents(item.agents),
    targetRoots,
    insertText,
    risk,
    priority,
  };
}

function scanQuickPromptFile(path: string, source: string): { prompts: QuickPromptItem[]; status: DiscoveryStatus; evidence: string } {
  if (!existsSync(path)) return { prompts: [], status: "missing", evidence: "source path does not exist" };
  try {
    const st = statSync(path);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { prompts?: unknown[] } | unknown[];
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.prompts) ? parsed.prompts : [];
    const prompts = rows
      .map((row) => normalizePrompt(row, source, path, st.mtimeMs))
      .filter((item): item is QuickPromptItem => Boolean(item));
    return { prompts, status: "ok", evidence: `${prompts.length} quick prompts found` };
  } catch (e) {
    return { prompts: [], status: "error", evidence: e instanceof Error ? e.message : String(e) };
  }
}

function scanQuickPrompts(): {
  prompts: QuickPromptItem[];
  sources: DiscoveryData["sources"];
} {
  const sources: DiscoveryData["sources"] = {};
  const builtIn = scanQuickPromptFile(QUICK_PROMPTS_FILE, "Dashboard quick prompts");
  const operator = scanQuickPromptFile(OPERATOR_QUICK_PROMPTS_FILE, "Operator quick prompts");

  sources["dashboard-quick-prompts"] = {
    status: builtIn.status,
    path: QUICK_PROMPTS_FILE,
    evidence: builtIn.evidence,
    count: builtIn.prompts.length,
  };
  sources["operator-quick-prompts"] = {
    status: operator.status,
    path: OPERATOR_QUICK_PROMPTS_FILE,
    evidence: operator.evidence,
    count: operator.prompts.length,
  };

  const byId = new Map<string, QuickPromptItem>();
  for (const prompt of builtIn.prompts) byId.set(prompt.id, prompt);
  for (const prompt of operator.prompts) byId.set(prompt.id, prompt);

  return {
    prompts: [...byId.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name)),
    sources,
  };
}

function promptAppliesToWorkspace(prompt: QuickPromptItem, workspaceRoot: string | null): boolean {
  if (prompt.targetRoots.length === 0) return true;
  if (!workspaceRoot) return false;
  return prompt.targetRoots.some((root) => workspaceRoot === resolve(root) || isWithin(workspaceRoot, resolve(root)));
}

function hydratePromptText(text: string, workspace: string | null, workspaceRoot: string | null): string {
  return text
    .replaceAll("{workspace}", workspace ?? workspaceRoot ?? "the current workspace")
    .replaceAll("{workspaceRoot}", workspaceRoot ?? workspace ?? "the current workspace");
}

function findMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
    }
  };
  try { walk(root, 0); } catch {}
  return files;
}

function parseCliCommands(help: string, source: string, agent: AgentId): CommandItem[] {
  const commands: CommandItem[] = [];
  let inCommands = false;
  for (const line of help.split(/\r?\n/)) {
    if (/^Commands:/.test(line.trim())) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (!line.trim() || /^Options:/.test(line.trim()) || /^Arguments:/.test(line.trim())) break;
    const m = line.match(/^\s{2,}([a-z][a-z0-9_-]*(?:\|[a-z][a-z0-9_-]*)?)\s{2,}(.+)$/i);
    if (!m) continue;
    commands.push({
      id: `${source}:${m[1]}`,
      name: m[1],
      description: m[2].trim(),
      source,
      agents: [agent],
    });
  }
  return commands;
}

function scanFileCommands(): { commands: CommandItem[]; sources: DiscoveryData["sources"] } {
  const commands: CommandItem[] = [];
  const sources: DiscoveryData["sources"] = {};

  for (const source of COMMAND_SOURCES) {
    if (!existsSync(source.path)) {
      sources[source.id] = { status: "missing", path: source.path, evidence: "source path does not exist", count: 0 };
      continue;
    }
    const files = findMarkdownFiles(source.path);
    sources[source.id] = { status: "ok", path: source.path, evidence: `${files.length} markdown commands found`, count: files.length };
    for (const file of files) {
      const item = markdownCommandFromFile(file, source.label, source.agents);
      if (item) commands.push(item);
    }
  }

  return { commands, sources };
}

async function probe(cmd: string, args: string[], timeoutMs = 4000, maxOutput = 8000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxOutput) stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const out = sanitize(stdout.trim(), maxOutput);
      const err = sanitize(stderr.trim(), maxOutput);
      resolve({
        status: timedOut ? "degraded" : code === 0 ? "ok" : "degraded",
        code: code ?? -1,
        stdout: out,
        stderr: err,
        evidence: timedOut
          ? `${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms`
          : `${cmd} ${args.join(" ")} exited ${code ?? -1}`,
      });
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: "missing", evidence: e.message, stderr: e.message });
    });
  });
}

function sessionSummary(path: string): { count: number; latestUpdatedAt: number | null } {
  const json = readJson(path) as { sessions?: Array<{ updatedAt?: number }> } | null;
  const sessions = Array.isArray(json?.sessions) ? json.sessions : [];
  return {
    count: sessions.length,
    latestUpdatedAt: sessions.reduce<number | null>((max, s) => {
      if (typeof s.updatedAt !== "number") return max;
      return max === null || s.updatedAt > max ? s.updatedAt : max;
    }, null),
  };
}

function healthSummary(path: string): { status: DiscoveryStatus; path: string; updatedAt: number | null; bestCloudHeavy?: string; bestCloudFast?: string } {
  if (!existsSync(path)) return { status: "missing", path, updatedAt: null };
  const st = statSync(path);
  const json = readJson(path) as { bestCloudHeavy?: string; bestCloudFast?: string } | null;
  return {
    status: json ? "ok" : "degraded",
    path,
    updatedAt: st.mtimeMs,
    bestCloudHeavy: json?.bestCloudHeavy,
    bestCloudFast: json?.bestCloudFast,
  };
}

function parseOpenCodeAgentNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s+\((primary|subagent)\)/);
    if (m && !names.includes(m[1])) names.push(m[1]);
    if (names.length >= 40) break;
  }
  return names;
}

function parseOutputLines(output: string, limit = 20): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function findDuplicates(skills: SkillItem[]): DiscoveryData["duplicates"] {
  const byName = new Map<string, SkillItem[]>();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), skill]);
  }
  return [...byName.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([name, items]) => ({
      name,
      count: items.length,
      paths: items.map((item) => item.sourcePath),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function filterAgent<T extends { agents: AgentId[] }>(items: T[], agent: AgentId | "all"): T[] {
  if (agent === "all") return items;
  return items.filter((item) => item.agents.includes(agent));
}

function emptyProbe(evidence: string): ProbeResult {
  return { status: "degraded", evidence };
}

function summaryFrom(data: DiscoveryData): DiscoveryData {
  return {
    ...data,
    skills: data.skills.map((skill) => ({
      ...skill,
      description: skill.description.slice(0, 240),
    })),
    commands: data.commands.map((command) => ({
      ...command,
      description: command.description.slice(0, 180),
    })),
    mcp: {
      claude: { ...data.mcp.claude, stdout: undefined, stderr: undefined },
      codex: { ...data.mcp.codex, stdout: undefined, stderr: undefined },
      opencode: { ...data.mcp.opencode, stdout: undefined, stderr: undefined },
      gemini: { ...data.mcp.gemini, stdout: undefined, stderr: undefined },
    },
    runtime: {
      ...data.runtime,
      opencodeSessions: {
        ...data.runtime.opencodeSessions,
        items: [],
      },
      opencodeModels: {
        ...data.runtime.opencodeModels,
        sample: data.runtime.opencodeModels.sample.slice(0, 5),
      },
      opencodeStats: {
        ...data.runtime.opencodeStats,
        sample: data.runtime.opencodeStats.sample.slice(0, 5),
      },
    },
  };
}

function buildCheapSummary(): DiscoveryData {
  const { skills, sources: skillSources } = scanSkills();
  const { commands, sources: commandSources } = scanFileCommands();
  return {
    skills,
    commands,
    sources: { ...skillSources, ...commandSources },
    cli: {
      claude: emptyProbe("full CLI probe deferred"),
      codex: emptyProbe("full CLI probe deferred"),
      opencode: emptyProbe("full CLI probe deferred"),
      gemini: emptyProbe("full CLI probe deferred"),
    },
    mcp: {
      claude: emptyProbe("full MCP probe deferred"),
      codex: emptyProbe("full MCP probe deferred"),
      opencode: emptyProbe("full MCP probe deferred"),
      gemini: emptyProbe("full MCP probe deferred"),
    },
    runtime: {
      claudeSessions: sessionSummary(CLAUDE_STATE),
      codexSessions: sessionSummary(CODEX_STATE),
      opencodeSessions: { count: 0, items: [], status: "degraded", evidence: "OpenCode session probe deferred" },
      opencodeAgents: { count: 0, names: [], status: "degraded", evidence: "OpenCode agent probe deferred" },
      opencodeModels: { sample: [], status: "degraded", evidence: "OpenCode model probe deferred" },
      opencodeStats: { sample: [], status: "degraded", evidence: "OpenCode stats probe deferred" },
      geminiSessions: sessionSummary(GEMINI_STATE),
      modelHealth: healthSummary(MODEL_HEALTH),
      gpuHealth: healthSummary(GPU_HEALTH),
    },
    duplicates: findDuplicates(skills),
  };
}

async function buildDiscovery(): Promise<DiscoveryData> {
  const { skills, sources: skillSources } = scanSkills();
  const { commands: fileCommands, sources: commandSources } = scanFileCommands();

  const [
    claudeVersion,
    codexVersion,
    geminiVersion,
    claudeHelp,
    codexHelp,
    geminiHelp,
    claudeMcp,
    codexMcp,
    geminiMcp,
  ] = await Promise.all([
    probe(CLAUDE_BIN, ["--version"], 3000, 1200),
    probe(CODEX_BIN, ["--version"], 3000, 1200),
    probe(GEMINI_BIN, ["--version"], 3000, 1200),
    probe(CLAUDE_BIN, ["--help"], 3000, 6000),
    probe(CODEX_BIN, ["--help"], 3000, 6000),
    probe(GEMINI_BIN, ["--help"], 3000, 6000),
    probe(CLAUDE_BIN, ["mcp", "list"], 5000, 6000),
    probe(CODEX_BIN, ["mcp", "list"], 5000, 6000),
    probe(GEMINI_BIN, ["mcp", "list"], 5000, 6000),
  ]);

  const opencodeVersion = await probe(OPENCODE_BIN, ["-v"], 5000, 1200);
  const opencodeHelp = await probe(OPENCODE_BIN, ["--help"], 5000, 6000);
  const opencodeMcp = await probe(OPENCODE_BIN, ["mcp", "list"], 8000, 6000);
  const opencodeSessions = await probe(OPENCODE_BIN, ["session", "list", "--format", "json", "--max-count", "10"], 8000, 8000);
  const opencodeAgents = await probe(OPENCODE_BIN, ["agent", "list"], 10_000, 120_000);
  const opencodeModels = await probe(OPENCODE_BIN, ["models"], 10_000, 8000);
  const opencodeStats = await probe(OPENCODE_BIN, ["stats", "--days", "7", "--models", "10"], 10_000, 8000);

  const cliCommands = [
    ...parseCliCommands(claudeHelp.stdout ?? "", "Claude CLI", "claude"),
    ...parseCliCommands(codexHelp.stdout ?? "", "Codex CLI", "codex"),
    ...parseCliCommands(opencodeHelp.stdout ?? "", "OpenCode CLI", "opencode"),
    ...parseCliCommands(geminiHelp.stdout ?? "", "Gemini CLI", "gemini"),
  ];

  let openCodeSessionItems: unknown[] = [];
  if (opencodeSessions.status === "ok" && opencodeSessions.stdout) {
    try {
      const parsed = JSON.parse(opencodeSessions.stdout) as unknown;
      if (Array.isArray(parsed)) openCodeSessionItems = parsed;
    } catch {}
  }

  const opencodeAgentNames = parseOpenCodeAgentNames(opencodeAgents.stdout ?? "");

  return {
    skills,
    commands: [...fileCommands, ...cliCommands].sort((a, b) => a.name.localeCompare(b.name)),
    sources: { ...skillSources, ...commandSources },
    cli: {
      claude: claudeVersion,
      codex: codexVersion,
      opencode: opencodeVersion,
      gemini: geminiVersion,
    },
    mcp: {
      claude: claudeMcp,
      codex: codexMcp,
      opencode: opencodeMcp,
      gemini: geminiMcp,
    },
    runtime: {
      claudeSessions: sessionSummary(CLAUDE_STATE),
      codexSessions: sessionSummary(CODEX_STATE),
      opencodeSessions: {
        count: openCodeSessionItems.length,
        items: openCodeSessionItems,
        status: opencodeSessions.status,
        evidence: opencodeSessions.evidence,
      },
      opencodeAgents: {
        count: opencodeAgentNames.length,
        names: opencodeAgentNames,
        status: opencodeAgents.status,
        evidence: opencodeAgents.evidence,
      },
      opencodeModels: {
        sample: parseOutputLines(opencodeModels.stdout ?? ""),
        status: opencodeModels.status,
        evidence: opencodeModels.evidence,
      },
      opencodeStats: {
        sample: parseOutputLines(opencodeStats.stdout ?? ""),
        status: opencodeStats.status,
        evidence: opencodeStats.evidence,
      },
      geminiSessions: sessionSummary(GEMINI_STATE),
      modelHealth: healthSummary(MODEL_HEALTH),
      gpuHealth: healthSummary(GPU_HEALTH),
    },
    duplicates: findDuplicates(skills),
  };
}

async function getDiscovery(): Promise<DiscoveryData> {
  if (discoveryCache && Date.now() - discoveryCache.at < CACHE_MS) {
    return discoveryCache.data;
  }
  const data = await buildDiscovery();
  discoveryCache = { at: Date.now(), data };
  return data;
}

export async function agentsSkillsHandler(url: URL): Promise<Response> {
  const agentParam = url.searchParams.get("agent") ?? "all";
  const agent = ["claude", "codex", "opencode", "gemini", "all"].includes(agentParam)
    ? agentParam as AgentId | "all"
    : "all";
  const { skills, sources: skillSources } = scanSkills();
  const { commands: fileCommands, sources: commandSources } = scanFileCommands();
  const helpTargets: Array<[AgentId, string, string[]]> = [];
  if (agent === "all" || agent === "claude") helpTargets.push(["claude", CLAUDE_BIN, ["--help"]]);
  if (agent === "all" || agent === "codex") helpTargets.push(["codex", CODEX_BIN, ["--help"]]);
  if (agent === "all" || agent === "opencode") helpTargets.push(["opencode", OPENCODE_BIN, ["--help"]]);
  const helpResults = await Promise.all(
    helpTargets.map(async ([target, cmd, args]) => ({
      target,
      result: await probe(cmd, args, 2500, 6000),
    })),
  );
  const cliCommands = helpResults.flatMap(({ target, result }) => {
    const source = target === "claude" ? "Claude CLI" : target === "codex" ? "Codex CLI" : "OpenCode CLI";
    return parseCliCommands(result.stdout ?? "", source, target);
  });
  const commands = [...fileCommands, ...cliCommands].sort((a, b) => a.name.localeCompare(b.name));
  return json({
    generatedAt: new Date().toISOString(),
    agent,
    skills: filterAgent(skills, agent),
    commands: filterAgent(commands, agent),
    duplicates: findDuplicates(skills),
    sources: { ...skillSources, ...commandSources },
  });
}

export function agentsQuickPromptsHandler(url: URL): Response {
  const agentParam = url.searchParams.get("agent") ?? "all";
  const agent = ["claude", "codex", "opencode", "gemini", "all"].includes(agentParam)
    ? agentParam as AgentId | "all"
    : "all";
  const cwd = url.searchParams.get("cwd");
  const workspace = cwd ? resolve(cwd) : null;
  const workspaceRoot = workspaceRootFor(cwd);
  const { prompts, sources } = scanQuickPrompts();
  const scoped = filterAgent(prompts, agent)
    .filter((prompt) => promptAppliesToWorkspace(prompt, workspaceRoot))
    .map((prompt) => ({
      ...prompt,
      insertText: hydratePromptText(prompt.insertText, workspace, workspaceRoot),
    }));

  return json({
    generatedAt: new Date().toISOString(),
    agent,
    cwd: workspace,
    workspaceRoot,
    quickPrompts: scoped,
    sources,
  });
}

export async function agentsDiscoveryHandler(): Promise<Response> {
  const data = await getDiscovery();
  return json({
    generatedAt: new Date().toISOString(),
    ...data,
  });
}

export async function agentsSummaryHandler(): Promise<Response> {
  const data = discoveryCache && Date.now() - discoveryCache.at < CACHE_MS
    ? summaryFrom(discoveryCache.data)
    : buildCheapSummary();
  const countFor = (agent: AgentId) => ({
    skills: filterAgent(data.skills, agent).length,
    commands: filterAgent(data.commands, agent).length,
    sessions: agent === "claude"
      ? data.runtime.claudeSessions.count
      : agent === "codex"
        ? data.runtime.codexSessions.count
        : agent === "gemini"
          ? data.runtime.geminiSessions.count
          : data.runtime.opencodeSessions.count,
  });
  return json({
    generatedAt: new Date().toISOString(),
    summary: true,
    counts: {
      claude: countFor("claude"),
      codex: countFor("codex"),
      opencode: countFor("opencode"),
      gemini: countFor("gemini"),
    },
    skills: data.skills,
    commands: data.commands,
    cli: data.cli,
    mcp: data.mcp,
    runtime: {
      claudeSessions: data.runtime.claudeSessions,
      codexSessions: data.runtime.codexSessions,
      opencodeSessions: {
        count: data.runtime.opencodeSessions.count,
        status: data.runtime.opencodeSessions.status,
      },
      opencodeAgents: data.runtime.opencodeAgents,
      opencodeModels: {
        sample: data.runtime.opencodeModels.sample.slice(0, 5),
        status: data.runtime.opencodeModels.status,
      },
      geminiSessions: data.runtime.geminiSessions,
      modelHealth: data.runtime.modelHealth,
      gpuHealth: data.runtime.gpuHealth,
    },
  });
}

export function agentsWorkspacesHandler(): Response {
  return json({
    roots: WORKSPACE_ROOTS.map((root) => ({
      ...root,
      exists: existsSync(root.path),
    })),
  });
}

function utcParts(now = new Date()): { date: string; time: string; stamp: string } {
  const iso = now.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    stamp: `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`,
  };
}

function field(value: unknown, fallback: string, limit = 1200): string {
  const text = typeof value === "string" ? value.trim() : "";
  return sanitize(text || fallback, limit).replace(/\n{3,}/g, "\n\n");
}

function ensureMarkdownFile(path: string, heading: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) appendFileSync(path, `${heading}\n\n`, "utf8");
}

function appendSection(path: string, heading: string, section: string): void {
  ensureMarkdownFile(path, heading);
  appendFileSync(path, `\n${section.trim()}\n`, "utf8");
}

export async function agentsVaultLogHandler(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    agent?: AgentId;
    sessionId?: string;
    title?: string;
    directory?: string;
    messageCount?: number;
    goal?: string;
    changed?: string;
    evidence?: string;
    next?: string;
    includeVault?: boolean;
    includeProject?: boolean;
    includeMasterPlan?: boolean;
  };

  const agent = ["claude", "codex", "opencode", "gemini"].includes(body.agent ?? "")
    ? body.agent as AgentId
    : "opencode";
  const { date, time, stamp } = utcParts();
  const title = field(body.title, "Untitled session", 240);
  const directory = field(body.directory, "unknown workspace", 240);
  const sessionId = field(body.sessionId, "unknown-session", 240);
  const messageCount = Number.isFinite(body.messageCount) ? Number(body.messageCount) : 0;
  const goal = field(body.goal, `Log ${agent} session: ${title}`);
  const changed = field(body.changed, `Agent session in ${directory}; ${messageCount} messages.`);
  const evidence = field(body.evidence, `Dashboard ${agent} session ${sessionId}; manual browser vault log.`);
  const next = field(body.next, "Continue from the relevant dashboard or stack plan.");

  const dailyPath = join(DAILY_VAULT_DIR, `${date}.md`);
  const section = `### ${time} UTC - Dashboard agent log (${agent})

**Goal**: ${goal}
**Session**: ${title} (\`${sessionId}\`)
**Workspace**: \`${directory}\`
**Changed**: ${changed}
**Evidence**: ${evidence}
**Next**: ${next}
`;

  const includeVault = body.includeVault !== false;
  const includeProject = body.includeProject !== false;
  const written: string[] = [];
  if (includeVault) {
    appendSection(dailyPath, `# ${date}`, section);
    written.push(dailyPath);
  }
  if (includeProject) {
    appendSection(DASHBOARD_PROJECT_NOTE, "# Dashboard V3 - Visual Redesign (Phase 7)", section);
    written.push(DASHBOARD_PROJECT_NOTE);
  }

  if (body.includeMasterPlan) {
    const masterEntry = `### ${stamp} - Control Surface
STATUS: ${goal}
CHANGES: ${changed}
EVIDENCE: ${evidence}
NEXT: ${next}
`;
    appendSection(MASTER_PLAN, "# MIMULE Master Plan V3", masterEntry);
    written.push(MASTER_PLAN);
  }

  return json({
    ok: true,
    written,
    generatedAt: new Date().toISOString(),
  });
}
