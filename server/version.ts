import { execFileSync } from "node:child_process";

export const VERSION = "1.0.0";

const REPO_ROOT = new URL("..", import.meta.url);

function gitRevParse(args: string[]): string | null {
  try {
    const value = execFileSync("git", ["rev-parse", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

const detectedCommit = gitRevParse(["HEAD"]);
export const BUILD_COMMIT = process.env.BUILD_COMMIT ?? detectedCommit ?? "dev";
export const BUILD_TIME = process.env.BUILD_TIME ?? new Date().toISOString();
export const BUILD_HASH = process.env.BUILD_HASH ?? gitRevParse(["--short", "HEAD"]) ?? (BUILD_COMMIT === "dev" ? "dev" : BUILD_COMMIT.slice(0, 7));

export interface VersionInfo {
  version: string;
  buildHash: string;
  apiVersion: "v1";
  commit: string;
  buildTime: string;
  nodeEnv: string;
  platform: string;
  arch: string;
}

export function getVersionInfo(): VersionInfo {
  return {
    version: VERSION,
    buildHash: BUILD_HASH,
    apiVersion: "v1",
    commit: BUILD_COMMIT,
    buildTime: BUILD_TIME,
    nodeEnv: process.env.NODE_ENV ?? "development",
    platform: process.platform,
    arch: process.arch,
  };
}
