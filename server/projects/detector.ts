import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { Project } from "./types.ts";

export type DetectedProject = Partial<Project> & {
  planFiles?: string[];
};

function findPlanFiles(repoPath: string): string[] {
  const plans: string[] = [];
  try {
    const entries = readdirSync(repoPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (
        name === "PLAN.md" ||
        name === "AGENTS.md" ||
        /_PLAN.*\.md$/i.test(name)
      ) {
        plans.push(name);
      }
    }
  } catch {
    // ignore read errors
  }
  return plans;
}

function inferName(repoPath: string, packageJson?: { name?: string }): string {
  if (packageJson?.name && typeof packageJson.name === "string") {
    return packageJson.name;
  }
  return basename(repoPath);
}

export function detectProject(repoPath: string): DetectedProject {
  if (!repoPath || !existsSync(repoPath)) return {};

  const planFiles = findPlanFiles(repoPath);

  const hasBunLock = existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"));
  const hasPackageJson = existsSync(join(repoPath, "package.json"));
  const hasGoMod = existsSync(join(repoPath, "go.mod"));
  const hasCargoToml = existsSync(join(repoPath, "Cargo.toml"));
  const hasRequirements = existsSync(join(repoPath, "requirements.txt")) || existsSync(join(repoPath, "pyproject.toml"));
  const hasSetupPy = existsSync(join(repoPath, "setup.py"));

  let packageJson: { name?: string; scripts?: Record<string, string> } | undefined;
  if (hasPackageJson) {
    try {
      const raw = readFileSync(join(repoPath, "package.json"), "utf8");
      packageJson = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
    } catch {
      // ignore parse errors
    }
  }

  if (hasBunLock || (hasPackageJson && existsSync(join(repoPath, "tsconfig.json")))) {
    const validatorCommands: string[] = [];
    if (hasBunLock) {
      validatorCommands.push("bun run check");
      if (packageJson?.scripts?.test) {
        validatorCommands.push("bun test");
      }
      validatorCommands.push("bun run build");
    } else {
      if (packageJson?.scripts?.test) {
        validatorCommands.push("npm test");
      }
      validatorCommands.push("npm run build");
    }
    return {
      repoPath,
      name: inferName(repoPath, packageJson),
      language: "typescript",
      framework: hasBunLock ? "bun" : "node",
      validatorCommands,
      planFiles,
    };
  }

  if (hasGoMod) {
    return {
      repoPath,
      name: inferName(repoPath),
      language: "go",
      framework: "go",
      validatorCommands: ["go build ./...", "go test ./..."],
      planFiles,
    };
  }

  if (hasCargoToml) {
    return {
      repoPath,
      name: inferName(repoPath),
      language: "rust",
      framework: "cargo",
      validatorCommands: ["cargo check", "cargo test", "cargo build --release"],
      planFiles,
    };
  }

  if (hasRequirements || hasSetupPy) {
    const isPyproject = existsSync(join(repoPath, "pyproject.toml"));
    const validatorCommands: string[] = [];
    if (isPyproject) {
      validatorCommands.push("pytest");
    } else {
      validatorCommands.push("pytest", "python -m unittest discover");
    }
    return {
      repoPath,
      name: inferName(repoPath),
      language: "python",
      framework: isPyproject ? "pyproject" : "pip",
      validatorCommands,
      planFiles,
    };
  }

  if (hasPackageJson) {
    const validatorCommands: string[] = [];
    if (packageJson?.scripts?.test) {
      validatorCommands.push("npm test");
    }
    validatorCommands.push("npm run build");
    return {
      repoPath,
      name: inferName(repoPath, packageJson),
      language: "javascript",
      framework: "node",
      validatorCommands,
      planFiles,
    };
  }

  // No recognized language — return infra/unknown with plan files if present
  return {
    repoPath,
    name: inferName(repoPath),
    language: "unknown",
    framework: "unknown",
    validatorCommands: [],
    planFiles,
  };
}
