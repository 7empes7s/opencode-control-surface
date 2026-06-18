import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPreviewPreflight } from "./preview-server.ts";

let originalPath = "";
let originalExit: string | undefined;

beforeEach(() => {
  originalPath = process.env.PATH ?? "";
  originalExit = process.env.FAKE_NPX_EXIT;
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalExit === undefined) delete process.env.FAKE_NPX_EXIT;
  else process.env.FAKE_NPX_EXIT = originalExit;
});

function makeNxProject(): string {
  const root = mkdtempSync(join(tmpdir(), "preview-preflight-"));
  mkdirSync(join(root, "apps", "api"), { recursive: true });
  writeFileSync(join(root, "nx.json"), JSON.stringify({ targetDefaults: {} }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0" }));
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  writeFileSync(join(root, "apps", "api", "project.json"), JSON.stringify({
    name: "api-api",
    targets: {
      serve: { executor: "@nx/js:node" },
      build: { executor: "@nx/js:tsc" },
    },
  }));
  return root;
}

function installFakeNpx(exitCode: number): string {
  const bin = mkdtempSync(join(tmpdir(), "preview-fake-bin-"));
  const log = join(bin, "npx.log");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$@" >> "${log}"\nexit ${exitCode}\n`);
  chmodSync(join(bin, "npx"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  return log;
}

describe("runPreviewPreflight", () => {
  test("runs the Nx backend build before fullstack preview", async () => {
    const root = makeNxProject();
    const log = installFakeNpx(0);

    const result = await runPreviewPreflight(root, "fullstack");

    expect(result.ok).toBe(true);
    expect(result.diagnostics.join("\n")).toContain("Nx workspace detected");
    expect(result.diagnostics.join("\n")).toContain("Backend preflight passed");
    expect(await Bun.file(log).text()).toContain("nx build api-api --skip-nx-cache");
  });

  test("blocks fullstack preview when the selected backend build fails", async () => {
    const root = makeNxProject();
    const log = installFakeNpx(42);

    const result = await runPreviewPreflight(root, "fullstack");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Backend preflight failed: npx nx build api-api --skip-nx-cache");
    expect(await Bun.file(log).text()).toContain("nx build api-api --skip-nx-cache");
  });

  test("reports mixed lockfiles and package-manager mismatch without blocking web-only preview", async () => {
    const root = makeNxProject();
    writeFileSync(join(root, "package-lock.json"), "");

    const result = await runPreviewPreflight(root, "web");

    expect(result.ok).toBe(true);
    expect(result.diagnostics.join("\n")).toContain("Mixed lockfiles detected");
    expect(result.diagnostics.join("\n")).toContain("packageManager declares pnpm");
  });
});
