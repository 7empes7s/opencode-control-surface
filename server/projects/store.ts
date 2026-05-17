import { getDashboardDb } from "../db/dashboard.ts";
import type { Project } from "./types.ts";

type ProjectRow = {
  id: string;
  tenant_id: string;
  name: string;
  repo_path: string;
  language: string;
  framework: string;
  validator_commands_json: string;
  default_model_roster_json: string;
  default_policies_json: string;
  status: string;
  created_at: number;
  updated_at: number;
};

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    repoPath: row.repo_path,
    language: row.language,
    framework: row.framework,
    validatorCommands: JSON.parse(row.validator_commands_json || "[]"),
    defaultModelRoster: JSON.parse(row.default_model_roster_json || "[]"),
    defaultPolicies: JSON.parse(row.default_policies_json || "{}"),
    status: row.status || "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertProject(project: Omit<Project, "createdAt" | "updatedAt">): Project {
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard DB unavailable");
  const now = Date.now();
  db.query(`
    INSERT INTO projects (id, tenant_id, name, repo_path, language, framework,
      validator_commands_json, default_model_roster_json, default_policies_json,
      status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      name = excluded.name,
      repo_path = excluded.repo_path,
      language = excluded.language,
      framework = excluded.framework,
      validator_commands_json = excluded.validator_commands_json,
      default_model_roster_json = excluded.default_model_roster_json,
      default_policies_json = excluded.default_policies_json,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    project.id,
    project.tenantId,
    project.name,
    project.repoPath,
    project.language,
    project.framework,
    JSON.stringify(project.validatorCommands),
    JSON.stringify(project.defaultModelRoster),
    JSON.stringify(project.defaultPolicies),
    project.status,
    now,
    now
  );
  return getProject(project.id)!;
}

export function getProject(id: string): Project | null {
  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query<ProjectRow, [string]>(
    `SELECT * FROM projects WHERE id = ?`
  ).get(id);
  return row ? rowToProject(row) : null;
}

export function listProjects(tenantId: string): Project[] {
  const db = getDashboardDb();
  if (!db) return [];
  return db.query<ProjectRow, [string]>(
    `SELECT * FROM projects WHERE tenant_id = ? AND (status IS NULL OR status != 'deleted') ORDER BY created_at ASC`
  ).all(tenantId).map(rowToProject);
}

export function deleteProject(id: string): void {
  const db = getDashboardDb();
  if (!db) return;
  db.query("UPDATE projects SET status = 'deleted', updated_at = ? WHERE id = ?")
    .run(Date.now(), id);
}
