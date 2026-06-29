import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export type BuilderPlanSanityIssue = {
  code: string;
  severity: "blocker" | "warning";
  line?: number;
  text?: string;
  message: string;
  recommendation: string;
};

export type BuilderPlanSanityResult = {
  status: "ok" | "warning" | "blocked";
  issues: BuilderPlanSanityIssue[];
};

type PlanSanityOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  commandExists?: (command: string) => boolean;
};

type PlanItem = {
  line: number;
  text: string;
};

const APPLE_CREDENTIAL_KEYS = [
  "EAS_TOKEN",
  "EXPO_TOKEN",
  "APP_STORE_CONNECT_API_KEY",
  "APP_STORE_CONNECT_API_KEY_PATH",
  "APP_STORE_CONNECT_KEY_ID",
  "APP_STORE_CONNECT_ISSUER_ID",
  "APP_STORE_CONNECT_PRIVATE_KEY",
];

const GOOGLE_PLAY_CREDENTIAL_KEYS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
  "GOOGLE_PLAY_ANDROID_PUBLISHER_CREDENTIALS",
  "PLAY_STORE_SERVICE_ACCOUNT_JSON",
];

function defaultCommandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
  return result.status === 0;
}

function hasAnyEnv(env: NodeJS.ProcessEnv, keys: string[]): boolean {
  return keys.some((key) => {
    const value = env[key];
    if (!value || value.trim().length === 0) return false;
    if (key.endsWith("_PATH") || key === "GOOGLE_APPLICATION_CREDENTIALS") return existsSync(value);
    return true;
  });
}

function readPlanItems(planFile: string): PlanItem[] {
  const raw = readFileSync(planFile, "utf8");
  const lines = raw.split(/\r?\n/);
  const items: PlanItem[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(\s*)[-*]\s+\[ \]\s+(.*)$/);
    if (!match) continue;

    const indent = match[1].length;
    const textParts = [match[2].trim()];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      const nextCheckbox = nextLine.match(/^(\s*)[-*]\s+\[[ xX]\]\s+/);
      if (nextCheckbox && nextCheckbox[1].length <= indent) break;
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed) continue;
      if (/^#{1,6}\s+/.test(nextTrimmed)) break;
      const nextIndent = nextLine.match(/^\s*/)?.[0].length ?? 0;
      if (nextIndent > indent) textParts.push(nextTrimmed.replace(/^[-*]\s+/, ""));
    }
    items.push({ line: index + 1, text: textParts.join(" ") });
  }

  return items;
}

function issue(
  code: string,
  message: string,
  item: PlanItem,
  recommendation: string,
  severity: BuilderPlanSanityIssue["severity"] = "blocker",
): BuilderPlanSanityIssue {
  return { code, severity, line: item.line, text: item.text, message, recommendation };
}

export function analyzeBuilderPlanSanity(
  planFile: string,
  options: PlanSanityOptions = {},
): BuilderPlanSanityResult {
  const env = options.env ?? process.env;
  const currentPlatform = options.platform ?? process.platform;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const issues: BuilderPlanSanityIssue[] = [];

  if (!existsSync(planFile)) {
    return {
      status: "blocked",
      issues: [{
        code: "plan-file-missing",
        severity: "blocker",
        message: `plan file does not exist: ${planFile}`,
        recommendation: "Select an existing plan file before starting Builder.",
      }],
    };
  }

  const items = readPlanItems(planFile);
  if (items.length === 0) {
    issues.push({
      code: "no-actionable-plan-items",
      severity: "warning",
      message: "plan file has no unchecked or numbered action items",
      recommendation: "Add explicit unchecked plan items or choose a more specific active plan.",
    });
  }

  const hasAppleCredentials = hasAnyEnv(env, APPLE_CREDENTIAL_KEYS);
  const hasGooglePlayCredentials = hasAnyEnv(env, GOOGLE_PLAY_CREDENTIAL_KEYS);
  const hasIosSimulator = currentPlatform === "darwin" && commandExists("xcrun");

  for (const item of items) {
    if (/\b(testflight|eas\s+(build|submit|credentials)|app store connect|expo application services)\b/i.test(item.text) && !hasAppleCredentials) {
      issues.push(issue(
        "external-apple-credentials-unavailable",
        "plan item requires TestFlight/EAS credentials or App Store Connect access that are not available",
        item,
        "Move the item behind a credential gate, replace it with a local build/smoke task, or provide EAS/App Store Connect credentials.",
      ));
    }
    if (/\b(google play billing|play billing sandbox|google play console|play store billing|android billing sandbox)\b/i.test(item.text) && !hasGooglePlayCredentials) {
      issues.push(issue(
        "external-google-play-unavailable",
        "plan item requires Google Play Billing sandbox or Play Console credentials that are not available",
        item,
        "Downgrade this to a mocked billing test or provide Google Play service account credentials.",
      ));
    }
    if (/\b(real ios simulators?|ios simulators?|iphone simulators?|simctl|xcodebuild.*simulators?)\b/i.test(item.text) && !hasIosSimulator) {
      issues.push(issue(
        "external-ios-simulator-unavailable",
        "plan item requires real iOS simulator access, but this Builder host cannot provide it",
        item,
        "Downgrade this to web/mobile responsive checks or run the simulator task on a macOS worker.",
      ));
    }
  }

  const firstReleaseIndex = items.findIndex((item) => /\b(submit|publish|release|deploy|ship)\b.*\b(production|app store|play store|testflight)\b/i.test(item.text));
  const firstValidationIndex = items.findIndex((item) => /\b(build baseline|typecheck|test|validation|smoke|credential|profile)\b/i.test(item.text));
  if (firstReleaseIndex !== -1 && firstValidationIndex !== -1 && firstReleaseIndex < firstValidationIndex) {
    const item = items[firstReleaseIndex];
    issues.push(issue(
      "release-before-validation",
      "plan schedules a production or store release before validation or credential prerequisites",
      item,
      "Move build, smoke, validation, and credential tasks before release/deploy tasks.",
    ));
  }

  const hasBlocker = issues.some((item) => item.severity === "blocker");
  return { status: hasBlocker ? "blocked" : issues.length > 0 ? "warning" : "ok", issues };
}

export function getPlanSanityStartBlockers(planFile: string, options: PlanSanityOptions = {}): string[] {
  return analyzeBuilderPlanSanity(planFile, options)
    .issues
    .filter((issue) => issue.severity === "blocker")
    .map((issue) => {
      const prefix = issue.line ? `${issue.code} at line ${issue.line}` : issue.code;
      return `${prefix}: ${issue.message}`;
    });
}

export function scanPlanSanity(planFile: string, env: NodeJS.ProcessEnv = process.env): BuilderPlanSanityIssue[] {
  return analyzeBuilderPlanSanity(planFile, { env }).issues;
}
