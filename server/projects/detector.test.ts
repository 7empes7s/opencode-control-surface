import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject } from "./detector.ts";

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "detector-fixture-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath);
    if (relPath.includes("/")) {
      mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
    }
    writeFileSync(fullPath, content);
  }
  return dir;
}

describe("detectProject", () => {
  it("detects bun+typescript project from /opt/opencode-control-surface", () => {
    const result = detectProject("/opt/opencode-control-surface");
    expect(result.language).toBe("typescript");
    expect(result.framework).toBe("bun");
    expect(result.validatorCommands).toContain("bun run check");
    expect(result.repoPath).toBe("/opt/opencode-control-surface");
    expect(result.planFiles?.length).toBeGreaterThanOrEqual(1);
    expect(result.planFiles).toContain("AGENT_FRIENDLY_6_MONTH_PLAN.md");
  });

  it("returns partial config (no id, tenantId, etc.)", () => {
    const result = detectProject("/opt/opencode-control-surface");
    expect((result as Record<string, unknown>).id).toBeUndefined();
    expect((result as Record<string, unknown>).tenantId).toBeUndefined();
  });

  it("returns empty object for unknown/nonexistent repo", () => {
    const result = detectProject("/nonexistent/path/that/does/not/exist");
    expect(result).toEqual({});
  });

  it("returns empty object for empty string path", () => {
    const result = detectProject("");
    expect(result).toEqual({});
  });

  it("detects bun project with bun.lock and tsconfig.json", () => {
    const dir = makeFixture({
      "bun.lock": "",
      "package.json": JSON.stringify({ name: "bun-app", scripts: { test: "bun test" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "PLAN.md": "# Plan\n",
    });
    try {
      const result = detectProject(dir);
      expect(result.language).toBe("typescript");
      expect(result.framework).toBe("bun");
      expect(result.validatorCommands).toContain("bun run check");
      expect(result.validatorCommands).toContain("bun test");
      expect(result.name).toBe("bun-app");
      expect(result.planFiles).toContain("PLAN.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects node project with package.json and tsconfig.json", () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ name: "node-app", scripts: { test: "jest" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "AGENTS.md": "",
    });
    try {
      const result = detectProject(dir);
      expect(result.language).toBe("typescript");
      expect(result.framework).toBe("node");
      expect(result.validatorCommands).toContain("npm test");
      expect(result.name).toBe("node-app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects python project with pyproject.toml", () => {
    const dir = makeFixture({
      "pyproject.toml": "[tool.pytest.ini_options]\n",
      "BUILDER_PLAN.md": "# Build Plan\n",
    });
    try {
      const result = detectProject(dir);
      expect(result.language).toBe("python");
      expect(result.framework).toBe("pyproject");
      expect(result.validatorCommands).toContain("pytest");
      expect(result.planFiles).toContain("BUILDER_PLAN.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects python project with requirements.txt", () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "setup.py": "from setuptools import setup\n",
    });
    try {
      const result = detectProject(dir);
      expect(result.language).toBe("python");
      expect(result.framework).toBe("pip");
      expect(result.validatorCommands).toContain("pytest");
      expect(result.validatorCommands).toContain("python -m unittest discover");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects go project with go.mod", () => {
    const dir = makeFixture({
      "go.mod": "module example.com/test\n\ngo 1.22\n",
      "main.go": "package main\n",
      "MONTH7_PLAN.md": "",
    });
    try {
      const result = detectProject(dir);
      expect(result.language).toBe("go");
      expect(result.framework).toBe("go");
      expect(result.validatorCommands).toContain("go build ./...");
      expect(result.validatorCommands).toContain("go test ./...");
      expect(result.planFiles).toContain("MONTH7_PLAN.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects rust project with Cargo.toml", () => {
    const dir = makeFixture({
      "Cargo.toml": "[package]\nname = \"rust-app\"\nversion = \"0.1.0\"\n",
      "src/main.rs": "fn main() {}\n",
    });
    try {
      const result = detectProject(dir);
      expect(result.language).toBe("rust");
      expect(result.framework).toBe("cargo");
      expect(result.validatorCommands).toContain("cargo check");
      expect(result.validatorCommands).toContain("cargo test");
      expect(result.validatorCommands).toContain("cargo build --release");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects plain javascript project with package.json only", () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ name: "js-app" }),
    });
    try {
      const result = detectProject(dir);
      expect(result.language).toBe("javascript");
      expect(result.framework).toBe("node");
      expect(result.validatorCommands).toContain("npm run build");
      expect(result.name).toBe("js-app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns unknown for no-language infra fixture", () => {
    const dir = makeFixture({
      "Dockerfile": "FROM alpine\n",
      "README.md": "# Infra\n",
      "PLAN.md": "# Infra Plan\n",
    });
    try {
      const result = detectProject(dir);
      expect(result.language).toBe("unknown");
      expect(result.framework).toBe("unknown");
      expect(result.validatorCommands).toEqual([]);
      expect(result.planFiles).toContain("PLAN.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("infers name from directory when package.json has no name", () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({}),
    });
    try {
      const result = detectProject(dir);
      expect(result.name).toBeDefined();
      expect(typeof result.name).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
