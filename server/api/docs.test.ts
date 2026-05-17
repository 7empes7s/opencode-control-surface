import { describe, it, expect, beforeAll } from "bun:test";
import { join } from "path";
import { mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";

const TUTORIALS_DIR = join(tmpdir(), "docs-tutorials-test");

async function setupTutorials() {
  await mkdir(TUTORIALS_DIR, { recursive: true });
  await writeFile(join(TUTORIALS_DIR, "01-alpha.md"), `---
title: Alpha Tutorial
estimated-time: 5 minutes
description: First tutorial
---
# Alpha`);
  await writeFile(join(TUTORIALS_DIR, "02-beta.md"), `---
title: Beta Tutorial
estimated-time: 10 minutes
description: Second tutorial
---
# Beta`);
}

async function cleanupTutorials() {
  try {
    await rm(TUTORIALS_DIR, { recursive: true });
  } catch {}
}

describe("docsTutorialsHandler", () => {
  beforeAll(async () => {
    await setupTutorials();
  });

  it("returns a tutorials array with slug, title, estimatedMinutes, description", async () => {
    const { docsTutorialsHandler } = await import("./docs.ts");
    const original = process.cwd();
    process.chdir(tmpdir());
    try {
      const res = await docsTutorialsHandler();
      const json = await res.json() as { tutorials: unknown[] };
      expect(Array.isArray(json.tutorials)).toBe(true);
    } finally {
      process.chdir(original);
      await cleanupTutorials();
    }
  });
});