import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBuildValidationCommand,
  getProjectValidationProfile,
  getValidationProfileStartBlockers,
} from "./validation-profile.ts";

function withProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "builder-validation-profile-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("builder validation profile discovery", () => {
  test("derives Nx build commands from project.json files", () => withProject((root) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
    writeFileSync(join(root, "nx.json"), JSON.stringify({}), "utf8");
    mkdirSync(join(root, "apps", "api"), { recursive: true });
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "apps", "api", "project.json"), JSON.stringify({ name: "api-api", targets: { build: {} } }), "utf8");
    writeFileSync(join(root, "apps", "web", "project.json"), JSON.stringify({ name: "web", targets: { build: {} } }), "utf8");

    const profile = getProjectValidationProfile(root);

    expect(profile.localExists).toBe(false);
    expect(profile.apiBuildCommand).toBe("npx nx run api-api:build --skip-nx-cache");
    expect(profile.webBuildCommand).toBe("npx nx run web:build --skip-nx-cache");
    expect(profile.commands).toContain("npx nx run api-api:build --skip-nx-cache");
    expect(profile.commands).toContain("npx nx run web:build --skip-nx-cache");
  }));

  test("does not invent npm run build without a root build script", () => withProject((root) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }), "utf8");

    const profile = getProjectValidationProfile(root);

    expect(profile.webBuildCommand).toBeNull();
    expect(getBuildValidationCommand(root)).not.toBe("npm run build");
    expect(profile.commands).toContain("npm test");
  }));

  test("blocks major runs until a local profile has required command slots", () => withProject((root) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }), "utf8");

    expect(getValidationProfileStartBlockers(root, "auto-continue")).toContain(`project-local validation profile missing at ${join(root, ".opencode", "validation-profile.json")}`);
    expect(getValidationProfileStartBlockers(root, "plan")).toEqual([]);

    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(join(root, ".opencode", "validation-profile.json"), JSON.stringify({
      installCommand: "npm ci",
      apiBuildCommand: "npm run build:api",
      webBuildCommand: "npm run build:web",
      apiSmokeCommand: "curl -fsS http://127.0.0.1:3000/health",
      webSmokeCommand: "curl -fsS http://127.0.0.1:3000/",
      commands: ["npm run build:web"],
      internal: ["npm run build:web"],
    }), "utf8");

    expect(getValidationProfileStartBlockers(root, "auto-continue")).toEqual([]);
  }));
});
