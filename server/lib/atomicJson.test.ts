import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readJsonFileAtomic } from "./atomicJson.ts";

function withTempFile(name: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "atomic-json-"));
  try {
    run(join(dir, name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readJsonFileAtomic retries a torn JSON write and returns the stable file", () => {
  withTempFile("model-health.json", (path) => {
    writeFileSync(path, "{", "utf8");
    const child = spawn("bash", [
      "-lc",
      `sleep 0.03; printf '%s' '{"models":[{"logicalName":"stable"}]}' > "$1"`,
      "rewrite-model-health",
      path,
    ], { stdio: "ignore" });

    const parsed = readJsonFileAtomic<{ models: Array<{ logicalName: string }> }>(path, {
      attempts: 6,
      retryDelayMs: 40,
    });

    expect(parsed.models[0]?.logicalName).toBe("stable");
    child.kill();
  });
});

test("readJsonFileAtomic returns the configured fallback after repeated parse failures", () => {
  withTempFile("broken.json", (path) => {
    writeFileSync(path, "{", "utf8");

    const parsed = readJsonFileAtomic<{ models: unknown[] }>(path, {
      attempts: 2,
      retryDelayMs: 1,
      fallback: { models: [] },
    });

    expect(parsed).toEqual({ models: [] });
  });
});
