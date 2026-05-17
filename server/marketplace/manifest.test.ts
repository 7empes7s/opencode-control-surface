import { describe, it, expect } from "bun:test";
import { parseManifest, validateManifest } from "./manifest";
import { ManifestError } from "./types";

describe("parseManifest", () => {
  it("parses a valid manifest", () => {
    const manifest = {
      name: "echo-skill",
      version: "1.0.0",
      kind: "workflow-skill",
      description: "Returns input as output",
      entrypoint: "index.ts",
      inputs: {},
      outputs: {},
      permissions: [],
    };
    const result = parseManifest(JSON.stringify(manifest));
    expect(result.name).toBe("echo-skill");
    expect(result.version).toBe("1.0.0");
    expect(result.kind).toBe("workflow-skill");
    expect(result.permissions).toEqual([]);
  });

  it("throws ManifestError when name is missing", () => {
    const manifest = {
      version: "1.0.0",
      kind: "workflow-skill",
      entrypoint: "index.ts",
      permissions: [],
    };
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow(ManifestError);
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow("name");
  });

  it("throws ManifestError for invalid JSON", () => {
    expect(() => parseManifest("not json")).toThrow(ManifestError);
  });
});

describe("validateManifest", () => {
  it("returns no errors for a valid manifest", () => {
    const m = {
      name: "echo-skill",
      version: "1.0.0",
      description: "",
      kind: "workflow-skill" as const,
      entrypoint: "index.ts",
      inputs: {},
      outputs: {},
      permissions: [],
    };
    expect(validateManifest(m)).toEqual([]);
  });

  it("rejects entrypoint with '..'", () => {
    const m = {
      name: "echo-skill",
      version: "1.0.0",
      description: "",
      kind: "workflow-skill" as const,
      entrypoint: "../bin/evil.ts",
      inputs: {},
      outputs: {},
      permissions: [],
    };
    const errors = validateManifest(m);
    expect(errors.some((e) => e.includes(".."))).toBe(true);
  });

  it("rejects unknown permission", () => {
    const m = {
      name: "echo-skill",
      version: "1.0.0",
      description: "",
      kind: "workflow-skill" as const,
      entrypoint: "index.ts",
      inputs: {},
      outputs: {},
      permissions: ["policy.execute_action", "unknown.permission" as any],
    };
    const errors = validateManifest(m);
    expect(errors.some((e) => e.includes("unknown permission"))).toBe(true);
  });
});