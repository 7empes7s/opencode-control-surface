import { checkToken } from "./actions.ts";
import { upsertProject, getProject, listProjects, deleteProject, detectProject } from "../projects/index.ts";
import { writeActionAudit } from "../db/writer.ts";
import type { Project } from "../projects/types.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { requireMutation } from "../governance/rbac.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function operatorOnly(req: Request): Response | null {
  if (!checkToken(req)) return json({ error: "unauthorized" }, 401);
  return null;
}

function mutationOnly(req: Request): Response | null {
  return requireMutation(req);
}

export function projectsListHandler(req: Request, url: URL): Response {
  const guard = operatorOnly(req);
  if (guard) return guard;
  const paramTenantId = url.searchParams.get("tenantId");
  const tenantId = paramTenantId || getCurrentTenantContext().tenantId;
  return json({ projects: listProjects(tenantId) });
}

export async function projectsCreateHandler(req: Request): Promise<Response> {
  const guard = mutationOnly(req);
  if (guard) return guard;
  let body: Partial<Omit<Project, "createdAt" | "updatedAt">>;
  try {
    body = await req.json() as Partial<Omit<Project, "createdAt" | "updatedAt">>;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.id || !body.tenantId) return json({ error: "id and tenantId are required" }, 400);
  const project = upsertProject({
    id: body.id,
    tenantId: body.tenantId,
    name: body.name ?? "",
    repoPath: body.repoPath ?? "",
    language: body.language ?? "",
    framework: body.framework ?? "",
    validatorCommands: body.validatorCommands ?? [],
    defaultModelRoster: body.defaultModelRoster ?? [],
    defaultPolicies: body.defaultPolicies ?? {},
    status: body.status ?? "active",
  });
  writeActionAudit({
    actionKind: "project.create",
    actionId: `project:create:${project.id}`,
    targetType: "project",
    targetId: project.id,
    risk: "low",
    request: body,
    result: `created project ${project.name}`,
    resultStatus: "success",
    evidence: [{ label: "Project", kind: "db", ref: `projects:${project.id}` }],
  });
  return json({ project }, 201);
}

export function projectGetHandler(req: Request, id: string): Response {
  const guard = operatorOnly(req);
  if (guard) return guard;
  const project = getProject(id);
  if (!project) return json({ error: "not found" }, 404);
  return json({ project });
}

export async function projectPatchHandler(req: Request, id: string): Promise<Response> {
  const guard = mutationOnly(req);
  if (guard) return guard;
  const existing = getProject(id);
  if (!existing) return json({ error: "not found" }, 404);
  let body: Partial<Omit<Project, "id" | "tenantId" | "createdAt" | "updatedAt">>;
  try {
    body = await req.json() as Partial<Omit<Project, "id" | "tenantId" | "createdAt" | "updatedAt">>;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const project = upsertProject({
    id: existing.id,
    tenantId: existing.tenantId,
    name: body.name ?? existing.name,
    repoPath: body.repoPath ?? existing.repoPath,
    language: body.language ?? existing.language,
    framework: body.framework ?? existing.framework,
    validatorCommands: body.validatorCommands ?? existing.validatorCommands,
    defaultModelRoster: body.defaultModelRoster ?? existing.defaultModelRoster,
    defaultPolicies: body.defaultPolicies ?? existing.defaultPolicies,
    status: body.status ?? existing.status,
  });
  return json({ project });
}

export function projectDeleteHandler(req: Request, id: string): Response {
  const guard = mutationOnly(req);
  if (guard) return guard;
  const existing = getProject(id);
  if (!existing) return json({ error: "not found" }, 404);
  deleteProject(id);
  return json({ ok: true });
}

export async function projectsDetectHandler(req: Request): Promise<Response> {
  const guard = mutationOnly(req);
  if (guard) return guard;
  let body: { repoPath?: string };
  try {
    body = await req.json() as { repoPath?: string };
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.repoPath) return json({ error: "repoPath is required" }, 400);
  const detected = detectProject(body.repoPath);
  return json({ detected });
}
