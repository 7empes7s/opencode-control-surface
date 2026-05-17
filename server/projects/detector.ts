import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./types.ts";

export function detectProject(repoPath: string): Partial<Project> {
  if (!repoPath || !existsSync(repoPath)) return {};

  const hasBunLock = existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"));
  const hasPackageJson = existsSync(join(repoPath, "package.json"));
  const hasGoMod = existsSync(join(repoPath, "go.mod"));
  const hasRequirements = existsSync(join(repoPath, "requirements.txt")) || existsSync(join(repoPath, "pyproject.toml"));

  if (hasBunLock || (hasPackageJson && existsSync(join(repoPath, "tsconfig.json")))) {
    const validatorCommands: string[] = [];
    if (hasBunLock) {
      validatorCommands.push("bun run check", "bun test", "bun run build");
    } else {
      validatorCommands.push("npm test", "npm run build");
    }
    return {
      repoPath,
      language: "typescript",
      framework: hasBunLock ? "bun" : "node",
      validatorCommands,
    };
  }

  if (hasGoMod) {
    return {
      repoPath,
      language: "go",
      framework: "go",
      validatorCommands: ["go build ./...", "go test ./..."],
    };
  }

  if (hasRequirements) {
    return {
      repoPath,
      language: "python",
      framework: existsSync(join(repoPath, "pyproject.toml")) ? "pyproject" : "pip",
      validatorCommands: ["pytest"],
    };
  }

  if (hasPackageJson) {
    return {
      repoPath,
      language: "javascript",
      framework: "node",
      validatorCommands: ["npm test"],
    };
  }

  return {};
}
