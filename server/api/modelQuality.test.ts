import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setModelQualityStatus } from "./modelQuality.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "model-quality-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("setModelQualityStatus updates nested models map without top-level model keys", () => {
  const path = join(tempDir, "model-quality.json");
  writeFileSync(path, JSON.stringify({
    models: {
      "demo-model": {
        status: "probation",
        successes: 7,
        recentFailures: [1, 2],
        consecutiveGarbage: 3,
      },
    },
  }));

  setModelQualityStatus("demo-model", "blocked", path);
  let quality = JSON.parse(readFileSync(path, "utf8"));
  expect(quality["demo-model"]).toBeUndefined();
  expect(quality.models["demo-model"].status).toBe("blocked");
  expect(quality.models["demo-model"].successes).toBe(7);

  setModelQualityStatus("demo-model", "healthy", path);
  quality = JSON.parse(readFileSync(path, "utf8"));
  expect(quality.models["demo-model"].status).toBe("healthy");
  expect(quality.models["demo-model"].recentFailures).toBe(0);
  expect(quality.models["demo-model"].consecutiveGarbage).toBe(0);
});
