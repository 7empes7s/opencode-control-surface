import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { parseManifest, validateManifest } from "./manifest";
import type { SkillManifest } from "./types";

// Mock manifest for install test
function makeEchoManifest(name: string, version: string = "1.0.0"): string {
  return JSON.stringify({
    name,
    version,
    kind: "workflow-skill",
    description: "Test skill",
    entrypoint: "index.ts",
    inputs: {},
    outputs: {},
    permissions: [],
  });
}

describe("marketplace API manifest handling", () => {
  describe("parseManifest", () => {
    it("parses valid JSON manifest", () => {
      const json = makeEchoManifest("test-skill");
      const result = parseManifest(json);
      expect(result.name).toBe("test-skill");
      expect(result.kind).toBe("workflow-skill");
    });

    it("throws on invalid JSON", () => {
      expect(() => parseManifest("not json")).toThrow();
    });

    it("throws when name is missing", () => {
      const json = JSON.stringify({ version: "1.0.0", kind: "workflow-skill", entrypoint: "index.ts" });
      expect(() => parseManifest(json)).toThrow("name");
    });
  });

  describe("validateManifest", () => {
    it("returns no errors for valid manifest", () => {
      const m: SkillManifest = {
        name: "test-skill",
        version: "1.0.0",
        description: "",
        kind: "workflow-skill",
        entrypoint: "index.ts",
        inputs: {},
        outputs: {},
        permissions: [],
      };
      expect(validateManifest(m)).toEqual([]);
    });

    it("rejects path traversal in entrypoint", () => {
      const m: SkillManifest = {
        name: "test-skill",
        version: "1.0.0",
        description: "",
        kind: "workflow-skill",
        entrypoint: "../bin/evil.ts",
        inputs: {},
        outputs: {},
        permissions: [],
      };
      const errors = validateManifest(m);
      expect(errors.some((e) => e.includes(".."))).toBe(true);
    });

    it("rejects unknown permission", () => {
      const m: SkillManifest = {
        name: "test-skill",
        version: "1.0.0",
        description: "",
        kind: "workflow-skill",
        entrypoint: "index.ts",
        inputs: {},
        outputs: {},
        permissions: ["not.real.permission" as any],
      };
      const errors = validateManifest(m);
      expect(errors.some((e) => e.includes("unknown permission"))).toBe(true);
    });

    it("rejects invalid semver", () => {
      const m: SkillManifest = {
        name: "test-skill",
        version: "1",
        description: "",
        kind: "workflow-skill",
        entrypoint: "index.ts",
        inputs: {},
        outputs: {},
        permissions: [],
      };
      const errors = validateManifest(m);
      expect(errors.some((e) => e.includes("semver"))).toBe(true);
    });

    it("accepts valid kind values", () => {
      const kinds = ["provider-adapter", "agent-adapter", "validator-adapter", "notification-sink", "workflow-skill"];
      for (const kind of kinds) {
        const m: SkillManifest = {
          name: "test-skill",
          version: "1.0.0",
          description: "",
          kind: kind as SkillManifest["kind"],
          entrypoint: "index.ts",
          inputs: {},
          outputs: {},
          permissions: [],
        };
        expect(validateManifest(m)).toEqual([]);
      }
    });
  });
});