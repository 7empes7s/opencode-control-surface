import { getDashboardDb } from "../db/dashboard.ts";
import type { InstalledSkill, SkillRunContext, SkillPermission } from "./types.ts";
import { PermissionDeniedError } from "./types.ts";

export interface SkillRunner {
  run(input: unknown): Promise<unknown>;
}

export function loadSkill(skill: InstalledSkill, ctx: SkillRunContext): SkillRunner {
  const entrypointPath = `${skill.bundlePath}/${skill.entrypoint}`;

  return {
    async run(input: unknown): Promise<unknown> {
      const skillEnv = buildSkillEnv(ctx, input);

      const proc = Bun.spawn(["bun", entrypointPath], {
        env: { ...process.env, ...skillEnv },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutMs = 60_000;
      const timedOut = await Promise.race([
        proc.exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
      ]);

      if (timedOut) {
        proc.kill();
        throw new Error(`Skill '${skill.name}' timed out after ${timeoutMs / 1000}s`);
      }

      const exitCode = proc.exitCode;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        throw new Error(`Skill exited with code ${exitCode}: ${stderr}`);
      }

      try {
        return JSON.parse(stdout.trim());
      } catch {
        throw new Error(`Skill stdout is not valid JSON: ${stdout.slice(0, 200)}`);
      }
    },
  };
}

export function buildSkillEnv(ctx: SkillRunContext, input?: unknown): Record<string, string> {
  const env: Record<string, string> = {
    TIB_SKILL_ID: ctx.skillId,
    TIB_TENANT_ID: ctx.tenantId,
    TIB_INSTANCE_ID: ctx.instanceId,
    TIB_PERMISSIONS: ctx.permissions.join(","),
  };

  if (input !== undefined) {
    env.TIB_INPUT = JSON.stringify(input);
  }

  const hasVaultRead = ctx.permissions.includes("vault.read");
  if (hasVaultRead && process.env.OPERATOR_TOKEN) {
    env.OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;
  }

  return env;
}

export function checkPermission(ctx: SkillRunContext, required: SkillPermission): void {
  if (!ctx.permissions.includes(required)) {
    throw new PermissionDeniedError(
      `Skill '${ctx.skillId}' lacks permission '${required}'`,
    );
  }
}

export function recordSkillRun(
  skillId: string,
  tenantId: string,
  instanceId: string,
  status: string,
  outputJson?: string,
  error?: string,
): void {
  const db = getDashboardDb();
  if (!db) return;

  const now = Date.now();
  const id = crypto.randomUUID();

  db.query(`
    INSERT INTO marketplace_skill_runs
      (id, skill_id, tenant_id, instance_id, started_at, finished_at, status, output_json, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, skillId, tenantId, instanceId, now, now, status, outputJson ?? null, error ?? null);
}