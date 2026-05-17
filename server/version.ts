export const VERSION = "1.0.0";
export const BUILD_COMMIT = process.env.BUILD_COMMIT ?? "dev";
export const BUILD_TIME = process.env.BUILD_TIME ?? new Date().toISOString();
export const BUILD_HASH = process.env.BUILD_HASH ?? (BUILD_COMMIT === "dev" ? "dev" : BUILD_COMMIT.slice(0, 7));

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