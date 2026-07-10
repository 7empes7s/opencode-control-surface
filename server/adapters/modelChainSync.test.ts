import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setRunShellForTests, type ShellResult } from "../api/shell.ts";
import {
  LITELLM_APPLY_COMMAND,
  computeChainDiff,
  getModelChainSyncPayload,
} from "./modelChainSync.ts";

type ShellCall = { command: string; timeout?: number };

let tempDir: string;
let previousHealthPath: string | undefined;
let previousConfigPath: string | undefined;
let shellCalls: ShellCall[];
let shellResponder: (command: string) => ShellResult;

const NOW = 1_700_000_000_000;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writeHealth(fallbacks: Record<string, string[]>, lastFullCheckAt = NOW - 1_000): void {
  writeFileSync(process.env.DASHBOARD_MODEL_HEALTH_PATH!, JSON.stringify({ lastFullCheckAt, fallbacks }), "utf8");
}

function installShellStub(): void {
  shellCalls = [];
  shellResponder = () => ({ ok: true, stdout: "[]" });
  setRunShellForTests((command, opts) => {
    shellCalls.push({ command, timeout: opts?.timeout });
    return shellResponder(command);
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "model-chain-sync-"));
  previousHealthPath = process.env.DASHBOARD_MODEL_HEALTH_PATH;
  previousConfigPath = process.env.DASHBOARD_LITELLM_CONFIG_PATH;
  process.env.DASHBOARD_MODEL_HEALTH_PATH = join(tempDir, "model-health.json");
  process.env.DASHBOARD_LITELLM_CONFIG_PATH = join(tempDir, "config with spaces.yaml");
  installShellStub();
});

afterEach(() => {
  setRunShellForTests(null);
  restoreEnv("DASHBOARD_MODEL_HEALTH_PATH", previousHealthPath);
  restoreEnv("DASHBOARD_LITELLM_CONFIG_PATH", previousConfigPath);
  rmSync(tempDir, { recursive: true, force: true });
});

describe("model chain sync preview", () => {
  test("computes in-sync, added, removed, reordered, and absent-chain diffs", () => {
    writeHealth({
      editorialHeavy: ["a", "b"],
      editorialFast: ["x", "y", "z"],
      editorialCloudHeavy: ["m1"],
      editorialCloudFast: ["r2", "r1"],
      ignoredRole: ["not-used"],
    });
    shellResponder = () => ({
      ok: true,
      stdout: JSON.stringify([
        { "editorial-heavy": ["a", "b"] },
        { "editorial-fast": ["x", "y"] },
        { "editorial-cloud-heavy": ["m1", "m2"] },
        { "editorial-cloud-fast": ["r1", "r2"] },
      ]),
    });

    const payload = getModelChainSyncPayload(NOW);
    expect(Object.keys(payload)).toEqual([
      "generatedAt",
      "healthAgeSec",
      "stale",
      "configReadError",
      "anyChanges",
      "chains",
      "correctedYamlBlock",
      "applyCommand",
    ]);
    expect(payload.configReadError).toBe(false);
    expect(payload.anyChanges).toBe(true);
    expect(payload.chains).toHaveLength(4);
    expect(payload.applyCommand).toBe(LITELLM_APPLY_COMMAND);
    expect(shellCalls[0].command).toContain("python3 -c 'import yaml,json,sys;");
    expect(shellCalls[0].command).toContain(`'${process.env.DASHBOARD_LITELLM_CONFIG_PATH}'`);

    expect(payload.chains.find((chain) => chain.role === "editorialHeavy")).toMatchObject({
      current: ["a", "b"],
      proposed: ["a", "b"],
      inSync: true,
      added: [],
      removed: [],
      reordered: false,
    });
    expect(payload.chains.find((chain) => chain.role === "editorialFast")).toMatchObject({
      current: ["x", "y"],
      proposed: ["x", "y", "z"],
      inSync: false,
      added: ["z"],
      removed: [],
      reordered: false,
    });
    expect(payload.chains.find((chain) => chain.role === "editorialCloudHeavy")).toMatchObject({
      current: ["m1", "m2"],
      proposed: ["m1"],
      inSync: false,
      added: [],
      removed: ["m2"],
      reordered: false,
    });
    expect(payload.chains.find((chain) => chain.role === "editorialCloudFast")).toMatchObject({
      current: ["r1", "r2"],
      proposed: ["r2", "r1"],
      inSync: false,
      added: [],
      removed: [],
      reordered: true,
    });

    expect(computeChainDiff("editorialHeavy", null, ["new-a", "new-b"])).toMatchObject({
      current: null,
      proposed: ["new-a", "new-b"],
      inSync: false,
      added: ["new-a", "new-b"],
      removed: [],
      reordered: false,
    });
  });

  test("generates a parseable corrected block that preserves non-editorial chains and order", () => {
    writeHealth({
      editorialHeavy: ["h-new"],
      editorialFast: ["f-new-1", "f-new-2"],
      editorialCloudHeavy: ["ch-new"],
      editorialCloudFast: ["cf-new"],
    });
    shellResponder = () => ({
      ok: true,
      stdout: JSON.stringify([
        { "routing-cheap": ["cheap-a", "cheap-b"] },
        { "editorial-heavy": ["h-old"] },
        { "mimule-chat": ["chat-a"] },
        { "editorial-fast": ["f-old"] },
        { "github-gpt41": ["github-a"] },
        { "editorial-cloud-heavy": ["ch-old"] },
      ]),
    });

    const payload = getModelChainSyncPayload(NOW);
    const parsed = spawnSync("python3", [
      "-c",
      "import yaml,json,sys;print(json.dumps(yaml.safe_load(sys.stdin)))",
    ], { input: payload.correctedYamlBlock, encoding: "utf8" });
    expect(parsed.status).toBe(0);

    const decoded = JSON.parse(parsed.stdout) as { router_settings: { fallbacks: Array<Record<string, string[]>> } };
    const fallbacks = decoded.router_settings.fallbacks;
    expect(fallbacks.map((entry) => Object.keys(entry)[0])).toEqual([
      "routing-cheap",
      "editorial-heavy",
      "mimule-chat",
      "editorial-fast",
      "github-gpt41",
      "editorial-cloud-heavy",
      "editorial-cloud-fast",
    ]);
    expect(fallbacks[0]["routing-cheap"]).toEqual(["cheap-a", "cheap-b"]);
    expect(fallbacks[2]["mimule-chat"]).toEqual(["chat-a"]);
    expect(fallbacks[4]["github-gpt41"]).toEqual(["github-a"]);
    expect(fallbacks[1]["editorial-heavy"]).toEqual(["h-new"]);
    expect(fallbacks[3]["editorial-fast"]).toEqual(["f-new-1", "f-new-2"]);
    expect(fallbacks[5]["editorial-cloud-heavy"]).toEqual(["ch-new"]);
    expect(fallbacks[6]["editorial-cloud-fast"]).toEqual(["cf-new"]);
    expect(payload.correctedYamlBlock).toContain("router_settings:\n  fallbacks:\n");
  });

  test("surfaces stale health and configReadError without throwing", () => {
    writeHealth({
      editorialHeavy: ["a"],
      editorialFast: ["b"],
      editorialCloudHeavy: ["c"],
      editorialCloudFast: ["d"],
    }, NOW - (7 * 3600 * 1000));
    shellResponder = () => ({ ok: false, stdout: "", stderr: "yaml read failed" });

    const payload = getModelChainSyncPayload(NOW);
    expect(payload.stale).toBe(true);
    expect(payload.healthAgeSec).toBe(7 * 3600);
    expect(payload.configReadError).toBe(true);
    expect(payload.chains).toHaveLength(4);
    for (const chain of payload.chains) {
      expect(chain.current).toBeNull();
      expect(chain.added).toEqual(chain.proposed);
      expect(chain.removed).toEqual([]);
      expect(chain.reordered).toBe(false);
    }
  });
});
