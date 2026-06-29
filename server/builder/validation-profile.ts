import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

export type ValidationProfileCommands = {
  install: string | null;
  apiBuild: string | null;
  webBuild: string | null;
  apiSmoke: string | null;
  webSmoke: string | null;
  commands: string[];
  internal: string[];
  runtime: string[];
  public: string[];
  packageManager: "bun" | "npm" | "pnpm" | "yarn" | "unknown";
  inferredFrom: string[];
  warnings: string[];
  hasLocalProfile: boolean;
  localProfilePath: string | null;
};

type ExternalServiceRule = {
  id: string;
  label: string;
  pattern: RegExp;
  isAvailable: (env: NodeJS.ProcessEnv) => boolean;
  missing: string;
};

export type ValidationProfileStartContext = string | {
  mode: string;
  trigger?: string;
  maxPasses?: number;
  agentOrder?: string[];
  agentCount?: number;
};

type PackageJson = { scripts?: Record<string, string> };
type NxProject = {
  name: string;
  root: string;
  projectJsonPath: string;
  targets: Record<string, { executor?: string }>;
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const NON_REQUIREMENT_RE = /\b(reject|downgrade|unavailable external service|avoid|do not|don't|non-goal|not required|document|detect generated apps)\b/i;
const ACTIONABLE_RE = /\b(require|requires|required|must|need|needs|configure|set up|setup|upload|submit|deploy|validate|test|run|build|enable|integrate|purchase)\b/i;

const EXTERNAL_SERVICE_RULES: ExternalServiceRule[] = [
  {
    id: "eas-credentials",
    label: "EAS credentials",
    pattern: /\b(eas credentials?|eas build|eas submit|expo application services)\b/i,
    isAvailable: (env) => Boolean(env.EAS_TOKEN || env.EXPO_TOKEN),
    missing: "set EAS_TOKEN or EXPO_TOKEN",
  },
  {
    id: "testflight",
    label: "TestFlight/App Store Connect",
    pattern: /\b(testflight|app store connect)\b/i,
    isAvailable: (env) => Boolean(
      env.APP_STORE_CONNECT_API_KEY_ID &&
      env.APP_STORE_CONNECT_ISSUER_ID &&
      (env.APP_STORE_CONNECT_API_PRIVATE_KEY || env.APP_STORE_CONNECT_API_PRIVATE_KEY_PATH),
    ),
    missing: "set APP_STORE_CONNECT_API_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, and APP_STORE_CONNECT_API_PRIVATE_KEY or APP_STORE_CONNECT_API_PRIVATE_KEY_PATH",
  },
  {
    id: "google-play-billing",
    label: "Google Play Billing sandbox",
    pattern: /\b(google play billing|play billing sandbox|billing sandbox|in-app purchase|iap)\b/i,
    isAvailable: (env) => Boolean(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS),
    missing: "set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS",
  },
  {
    id: "real-ios-simulator",
    label: "real iOS simulator",
    pattern: /\b(real ios simulator|ios simulator|simctl|xcodebuild)\b/i,
    isAvailable: (env) => {
      if (env.REAL_IOS_SIMULATOR_AVAILABLE === "1") return true;
      if (process.platform !== "darwin") return false;
      const result = spawnSync("xcrun", ["simctl", "list", "devices"], { encoding: "utf8", timeout: 5_000 });
      return result.status === 0;
    },
    missing: "run on a macOS host with xcrun simctl available, or set REAL_IOS_SIMULATOR_AVAILABLE=1 for a verified remote simulator",
  },
];

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function getCandidatePlanLines(planText: string): string[] {
  const lines = planText.split(/\r?\n/);
  const unchecked = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*[-*]\s+\[ \]/.test(line));
  if (unchecked.length === 0) return lines;

  const candidates: string[] = [];
  for (const item of unchecked) {
    candidates.push(item.line);
    const indent = item.line.match(/^\s*/)?.[0].length ?? 0;
    for (let index = item.index + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*[-*]\s+\[[ xX]\]/.test(line) && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      candidates.push(line);
    }
  }
  return candidates;
}

function isActionableRequirementLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || NON_REQUIREMENT_RE.test(trimmed)) return false;
  return /^\s*[-*]\s+\[ \]/.test(line) || ACTIONABLE_RE.test(trimmed);
}

export function getUnavailableExternalServicePlanBlockers(
  planFile: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!planFile || !existsSync(planFile)) return [];
  let planText = "";
  try {
    planText = readFileSync(planFile, "utf8");
  } catch {
    return [];
  }

  const blockers = new Map<string, string>();
  for (const line of getCandidatePlanLines(planText)) {
    if (!isActionableRequirementLine(line)) continue;
    for (const rule of EXTERNAL_SERVICE_RULES) {
      if (rule.pattern.test(line) && !rule.isAvailable(env)) {
        blockers.set(rule.id, `${rule.label} unavailable for plan item "${line.trim().slice(0, 140)}": ${rule.missing}`);
      }
    }
  }
  return [...blockers.values()];
}

export function detectPackageManager(projectRoot: string): ValidationProfileCommands["packageManager"] {
  if (existsSync(join(projectRoot, "bun.lock")) || existsSync(join(projectRoot, "bun.lockb"))) return "bun";
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectRoot, "package-lock.json"))) return "npm";
  if (existsSync(join(projectRoot, "package.json"))) return "npm";
  return "unknown";
}

function installCommandFor(projectRoot: string): string | null {
  const manager = detectPackageManager(projectRoot);
  if (manager === "bun") return "bun install --frozen-lockfile";
  if (manager === "pnpm") return "pnpm install --frozen-lockfile";
  if (manager === "yarn") return "yarn install --frozen-lockfile";
  if (manager === "npm") return existsSync(join(projectRoot, "package-lock.json")) ? "npm ci" : "npm install";
  return null;
}

function findNxProjects(projectRoot: string): NxProject[] {
  if (!existsSync(join(projectRoot, "nx.json"))) return [];
  const projects: NxProject[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    if (entries.includes("project.json")) {
      const projectJsonPath = join(dir, "project.json");
      const parsed = readJson<{ name?: string; targets?: Record<string, { executor?: string }> }>(projectJsonPath);
      if (parsed?.targets) {
        projects.push({
          name: parsed.name ?? basename(dir),
          root: relative(projectRoot, dir) || ".",
          projectJsonPath,
          targets: parsed.targets,
        });
      }
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry === "project.json") continue;
      const next = join(dir, entry);
      try {
        if (statSync(next).isDirectory()) walk(next, depth + 1);
      } catch { /* ignore */ }
    }
  };
  walk(projectRoot, 0);
  return projects;
}

function targetExecutor(project: NxProject, target: string): string {
  return project.targets[target]?.executor?.toLowerCase() ?? "";
}

function isApiProject(project: NxProject): boolean {
  const haystack = `${project.name} ${project.root} ${targetExecutor(project, "serve")} ${targetExecutor(project, "build")}`.toLowerCase();
  return /(^|[-_/])(api|server|backend)([-_/]|$)/.test(haystack) ||
    haystack.includes("@nx/js:node") ||
    haystack.includes("@nx/node") ||
    haystack.includes("nestjs");
}

function isWebProject(project: NxProject): boolean {
  const haystack = `${project.name} ${project.root} ${targetExecutor(project, "serve")} ${targetExecutor(project, "build")}`.toLowerCase();
  return /(^|[-_/])(web|app|frontend|client)([-_/]|$)/.test(haystack) ||
    haystack.includes("vite") ||
    haystack.includes("next") ||
    haystack.includes("react") ||
    haystack.includes("webpack");
}

function nxBuildCommand(project: NxProject): string {
  return `npx nx run ${project.name}:build --skip-nx-cache`;
}

function smokeCommandFor(url: string | null): string | null {
  if (!url) return null;
  return `curl -fsS ${url.replace(/\/$/, "")}/health`;
}

function readLocalProfile(projectRoot: string): Partial<ValidationProfileCommands> | null {
  const profilePath = join(projectRoot, ".opencode", "validation-profile.json");
  if (!existsSync(profilePath)) return null;
  const parsed = readJson<Record<string, unknown>>(profilePath);
  if (!parsed) return null;
  const asString = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
    return null;
  };
  const asList = (key: string): string[] => Array.isArray(parsed[key])
    ? (parsed[key] as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    install: asString("installCommand", "install", "install_command", "install-command"),
    apiBuild: asString("apiBuildCommand", "apiBuild", "api_build_command", "api-build-command", "api_build", "api-build"),
    webBuild: asString("webBuildCommand", "webBuild", "web_build_command", "web-build-command", "web_build", "web-build"),
    apiSmoke: asString("apiSmokeCommand", "apiSmoke", "api_smoke_command", "api-smoke-command", "api_smoke", "api-smoke"),
    webSmoke: asString("webSmokeCommand", "webSmoke", "web_smoke_command", "web-smoke-command", "web_smoke", "web-smoke"),
    commands: asList("commands"),
    internal: asList("internal"),
    runtime: asList("runtime"),
    public: asList("public"),
    inferredFrom: [profilePath],
    hasLocalProfile: true,
    localProfilePath: profilePath,
  };
}

export function deriveProjectValidationProfile(projectRoot: string, urls: { internalUrl?: string | null; publicUrl?: string | null } = {}): ValidationProfileCommands {
  const packageManager = detectPackageManager(projectRoot);
  const packageJsonPath = join(projectRoot, "package.json");
  const packageJson = existsSync(packageJsonPath) ? readJson<PackageJson>(packageJsonPath) : null;
  const scripts = packageJson?.scripts ?? {};
  const inferredFrom = new Set<string>();
  const warnings: string[] = [];
  if (packageJson) inferredFrom.add(packageJsonPath);

  const install = installCommandFor(projectRoot);
  let apiBuild: string | null = null;
  let webBuild: string | null = null;
  const apiSmoke = smokeCommandFor(urls.internalUrl ?? null);
  const webSmoke = smokeCommandFor(urls.publicUrl ?? urls.internalUrl ?? null);
  const internal: string[] = [];
  const runtime: string[] = [];
  const publicChecks: string[] = [];

  const nxProjects = findNxProjects(projectRoot);
  if (nxProjects.length > 0) {
    inferredFrom.add(join(projectRoot, "nx.json"));
    for (const project of nxProjects) inferredFrom.add(project.projectJsonPath);
    const buildable = nxProjects.filter((project) => project.targets.build);
    const apiProject = buildable.find(isApiProject);
    const webProject = buildable.find(isWebProject);
    apiBuild = apiProject ? nxBuildCommand(apiProject) : null;
    webBuild = webProject ? nxBuildCommand(webProject) : null;
    if (!apiBuild && buildable[0]) apiBuild = nxBuildCommand(buildable[0]);
    if (!webBuild) {
      const alternate = buildable.find((project) => project !== apiProject);
      if (alternate) webBuild = nxBuildCommand(alternate);
    }
  } else if (packageJson) {
    const runner = packageManager === "bun" ? "bun" : "npm";
    if (scripts.typecheck) internal.push(`${runner} run typecheck`);
    if (scripts.build) {
      webBuild = `${runner} run build`;
    } else {
      warnings.push("root package.json has no build script; no root build command inferred");
    }
    if (scripts.check) internal.push(`${runner} run check`);
    if (scripts.test) internal.push(packageManager === "bun" ? "bun test" : "npm test");
  }

  for (const command of [apiBuild, webBuild]) {
    if (command && !internal.includes(command)) internal.push(command);
  }
  if (apiSmoke) runtime.push(apiSmoke);
  if (webSmoke) publicChecks.push(webSmoke);

  const localProfile = readLocalProfile(projectRoot);
  const localProfilePath = join(projectRoot, ".opencode", "validation-profile.json");
  const merged: ValidationProfileCommands = {
    install: localProfile?.install ?? install,
    apiBuild: localProfile?.apiBuild ?? apiBuild,
    webBuild: localProfile?.webBuild ?? webBuild,
    apiSmoke: localProfile?.apiSmoke ?? apiSmoke,
    webSmoke: localProfile?.webSmoke ?? webSmoke,
    commands: localProfile?.commands?.length ? localProfile.commands : [...internal],
    internal: localProfile?.internal?.length ? localProfile.internal : internal,
    runtime: localProfile?.runtime?.length ? localProfile.runtime : runtime,
    public: localProfile?.public?.length ? localProfile.public : publicChecks,
    packageManager,
    inferredFrom: [...new Set([...(localProfile?.inferredFrom ?? []), ...inferredFrom])],
    warnings,
    hasLocalProfile: Boolean(localProfile?.hasLocalProfile),
    localProfilePath,
  };
  if (!merged.install) merged.warnings.push("no install command inferred");
  if (!merged.apiBuild) merged.warnings.push("no API build command inferred");
  if (!merged.webBuild) merged.warnings.push("no web build command inferred");
  if (!merged.apiSmoke) merged.warnings.push("no API smoke command inferred");
  if (!merged.webSmoke) merged.warnings.push("no web smoke command inferred");
  return merged;
}

export function missingLocalValidationProfileFields(profile: ValidationProfileCommands): string[] {
  if (!profile.hasLocalProfile) return ["validation-profile.json"];
  const missing: string[] = [];
  if (!profile.install) missing.push("installCommand");
  if (!profile.apiBuild) missing.push("apiBuildCommand");
  if (!profile.webBuild) missing.push("webBuildCommand");
  if (!profile.apiSmoke) missing.push("apiSmokeCommand");
  if (!profile.webSmoke) missing.push("webSmokeCommand");
  return missing;
}

export function getBuildValidationCommand(projectRoot: string): string | null {
  const profile = deriveProjectValidationProfile(projectRoot);
  return profile.webBuild ?? profile.apiBuild ?? profile.commands.find((command) => /\bbuild\b/.test(command)) ?? null;
}

function isMajorValidationContext(context: ValidationProfileStartContext): boolean {
  const mode = typeof context === "string" ? context : context.mode;
  const trigger = typeof context === "string" ? null : context.trigger;
  if (trigger === "doctor-review") return false;
  if (["auto-continue", "scheduled", "permanent"].includes(mode)) return true;
  if (typeof context === "string") return false;
  return (context.maxPasses ?? 1) > 1 || (context.agentCount ?? context.agentOrder?.length ?? 1) > 1;
}

export function getValidationProfileStartBlockers(
  projectRoot: string,
  context: ValidationProfileStartContext,
  urls: { internalUrl?: string | null; publicUrl?: string | null } = {},
  planFile?: string | null,
): string[] {
  if (!isMajorValidationContext(context)) return [];
  const profile = deriveProjectValidationProfile(projectRoot, urls);
  const missing = missingLocalValidationProfileFields(profile);
  const blockers = getUnavailableExternalServicePlanBlockers(planFile);
  if (missing.length === 0) return blockers;
  if (!profile.hasLocalProfile) {
    return [`project-local validation profile missing at ${profile.localProfilePath}`, ...blockers];
  }
  return [`project-local validation profile incomplete at ${profile.localProfilePath}: missing ${missing.join(", ")}`, ...blockers];
}

export function getProjectValidationProfile(projectRoot: string): {
  name: string;
  packageManager: "bun" | "npm" | "unknown";
  commands: string[];
  internal: string[];
  runtime: string[];
  public: string[];
  installCommand: string | null;
  apiBuildCommand: string | null;
  webBuildCommand: string | null;
  apiSmokeCommand: string | null;
  webSmokeCommand: string | null;
  localPath: string;
  localExists: boolean;
  inferredFrom: string[];
  warnings: string[];
  missingRequiredCommands: string[];
  status: "ok" | "missing" | "degraded" | "error";
} {
  const profile = deriveProjectValidationProfile(projectRoot);
  const missing = missingLocalValidationProfileFields(profile);
  const packageManager = profile.packageManager === "pnpm" || profile.packageManager === "yarn"
    ? "npm"
    : profile.packageManager;
  return {
    name: profile.hasLocalProfile ? "project-local validation profile" : "inferred validation profile",
    packageManager,
    commands: profile.commands,
    internal: profile.internal,
    runtime: profile.runtime,
    public: profile.public,
    installCommand: profile.install,
    apiBuildCommand: profile.apiBuild,
    webBuildCommand: profile.webBuild,
    apiSmokeCommand: profile.apiSmoke,
    webSmokeCommand: profile.webSmoke,
    localPath: profile.localProfilePath ?? join(projectRoot, ".opencode", "validation-profile.json"),
    localExists: profile.hasLocalProfile,
    inferredFrom: profile.inferredFrom,
    warnings: [
      ...profile.warnings,
      ...(profile.hasLocalProfile ? [] : ["project-local validation profile is missing"]),
    ],
    missingRequiredCommands: missing,
    status: missing.length === 0 ? "ok" : profile.hasLocalProfile ? "degraded" : "missing",
  };
}
