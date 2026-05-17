import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { parseManifest, validateManifest } from "./manifest";
import { installSkill, uninstallSkill, listSkills, enableSkill, disableSkill, getSkill } from "./registry";
import { parseManifest as parseM } from "./manifest";
import type { InstalledSkill } from "./types";

// We need to mock the DB for unit tests
// These tests use the real DB in /tmp so they are integration tests

const TEST_TMPDIR = "/tmp/marketplace-test-db";

function makeTmpDb() {
  const { mkdirSync, rmSync } = require("node:fs");
  try { rmSync(TEST_TMPDIR, { recursive: true }); } catch { /* ignore */ }
  mkdirSync(TEST_TMPDIR, { recursive: true });
  const path = `${TEST_TMPDIR}/test-${Date.now()}.sqlite`;
  process.env.DASHBOARD_DB_PATH = path;
  process.env.DASHBOARD_DB = "1";
  return path;
}

describe("marketplace registry integration", () => {
  const dbPath = makeTmpDb();

  // We need to actually initialize the DB tables first
  // For unit tests, we'll test the manifest parser in isolation

  describe("manifest validation", () => {
    it("valid manifest has no errors", () => {
      const m = {
        name: "test-skill",
        version: "1.0.0",
        description: "A test skill",
        kind: "workflow-skill",
        entrypoint: "index.ts",
        inputs: {},
        outputs: {},
        permissions: ["gateway.call"],
      };
      const errors = validateManifest(m as any);
      expect(errors).toEqual([]);
    });

    it("missing name fails", () => {
      const m = {
        version: "1.0.0",
        kind: "workflow-skill",
        entrypoint: "index.ts",
        permissions: [],
      };
      const errors = validateManifest(m as any);
      expect(errors.some((e: string) => e.includes("name"))).toBe(true);
    });

    it("invalid semver fails", () => {
      const m = {
        name: "test-skill",
        version: "1",
        kind: "workflow-skill",
        entrypoint: "index.ts",
        permissions: [],
      };
      const errors = validateManifest(m as any);
      expect(errors.some((e: string) => e.includes("semver"))).toBe(true);
    });

    it("unknown kind fails", () => {
      const m = {
        name: "test-skill",
        version: "1.0.0",
        kind: "unknown-kind",
        entrypoint: "index.ts",
        permissions: [],
      };
      const errors = validateManifest(m as any);
      expect(errors.some((e: string) => e.includes("kind"))).toBe(true);
    });

    it("path traversal in entrypoint fails", () => {
      const m = {
        name: "test-skill",
        version: "1.0.0",
        kind: "workflow-skill",
        entrypoint: "../bin/evil.ts",
        permissions: [],
      };
      const errors = validateManifest(m as any);
      expect(errors.some((e: string) => e.includes(".."))).toBe(true);
    });

    it("unknown permission fails", () => {
      const m = {
        name: "test-skill",
        version: "1.0.0",
        kind: "workflow-skill",
        entrypoint: "index.ts",
        permissions: ["not.a.real.permission"],
      };
      const errors = validateManifest(m as any);
      expect(errors.some((e: string) => e.includes("unknown permission"))).toBe(true);
    });
  });

  describe("parseManifest", () => {
    it("parses valid JSON manifest", () => {
      const json = JSON.stringify({
        name: "echo",
        version: "1.0.0",
        kind: "workflow-skill",
        description: "Returns input",
        entrypoint: "index.ts",
        inputs: { foo: { type: "string" } },
        outputs: { bar: { type: "string" } },
        permissions: ["gateway.call"],
        author: "Test",
      });
      const result = parseManifest(json);
      expect(result.name).toBe("echo");
      expect(result.version).toBe("1.0.0");
      expect(result.kind).toBe("workflow-skill");
      expect(result.permissions).toEqual(["gateway.call"]);
    });

    it("throws on invalid JSON", () => {
      expect(() => parseManifest("not json")).toThrow();
    });
  });
});