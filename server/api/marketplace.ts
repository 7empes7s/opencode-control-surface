import { ok, type ApiEnvelope } from "./types.ts";
import {
  listSkills,
  installSkill,
  uninstallSkill,
  enableSkill,
  disableSkill,
  getSkill,
} from "../marketplace/registry.ts";
import { loadSkill, recordSkillRun } from "../marketplace/loader.ts";
import { parseManifest, validateManifest } from "../marketplace/manifest.ts";
import type { SkillRunContext } from "../marketplace/types.ts";

function getTenantId(req: Request): string {
  return req.headers.get("X-Tenant-ID") ?? "mimule";
}

async function jsonBody<T>(req: Request): Promise<T> {
  return req.json() as Promise<T>;
}

export async function marketplaceListHandler(req: Request): Promise<Response> {
  try {
    const tenantId = getTenantId(req);
    const skills = listSkills(tenantId);
    return new Response(JSON.stringify(ok(skills)), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify(ok({ error: String(e) })), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function marketplaceInstallHandler(req: Request): Promise<Response> {
  try {
    const tenantId = getTenantId(req);
    const body = await jsonBody<{ bundlePath: string; manifestJson: string }>(req);

    const manifest = parseManifest(body.manifestJson);
    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      return Response.json(ok({ error: `Invalid manifest: ${errors.join("; ")}` }), { status: 400 });
    }

    const skill = installSkill(tenantId, body.bundlePath, body.manifestJson);
    return new Response(JSON.stringify(ok(skill)), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify(ok({ error: String(e) })), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function marketplaceDeleteHandler(req: Request, id: string): Promise<Response> {
  try {
    uninstallSkill(id);
    return new Response(JSON.stringify(ok({ id })), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify(ok({ error: String(e) })), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function marketplaceEnableHandler(req: Request, id: string): Promise<Response> {
  try {
    enableSkill(id);
    return new Response(JSON.stringify(ok({ id, status: "active" })), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify(ok({ error: String(e) })), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function marketplaceDisableHandler(req: Request, id: string): Promise<Response> {
  try {
    disableSkill(id);
    return new Response(JSON.stringify(ok({ id, status: "disabled" })), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify(ok({ error: String(e) })), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function marketplaceRunHandler(req: Request, id: string): Promise<Response> {
  try {
    const tenantId = getTenantId(req);
    const skill = getSkill(id);
    if (!skill) {
      return Response.json(ok({ error: "Skill not found" }), { status: 404 });
    }
    if (skill.status !== "active") {
      return Response.json(ok({ error: `Skill is ${skill.status}` }), { status: 400 });
    }

    const body = await jsonBody<{ input?: unknown; instanceId?: string }>(req);
    const instanceId = body.instanceId ?? crypto.randomUUID();

    const manifest = parseManifest(skill.manifestJson);
    const ctx: SkillRunContext = {
      skillId: id,
      tenantId,
      instanceId,
      permissions: manifest.permissions,
    };

    const runner = loadSkill(skill, ctx);
    const output = await runner.run(body.input ?? {});

    recordSkillRun(id, tenantId, instanceId, "success", JSON.stringify(output));

    return new Response(JSON.stringify(ok({ output })), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const tenantId = getTenantId(req);
    const instanceId = crypto.randomUUID();
    recordSkillRun(id, tenantId, instanceId, "error", undefined, String(e));

    return new Response(JSON.stringify(ok({ error: String(e) })), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function marketplaceRunsHandler(req: Request, id: string): Promise<Response> {
  try {
    const { getDashboardDb } = await import("../db/dashboard.ts");
    const db = getDashboardDb();
    if (!db) return Response.json(ok({ runs: [] }));

    const rows = db.query(
      `SELECT * FROM marketplace_skill_runs WHERE skill_id = ? ORDER BY started_at DESC LIMIT 20`,
    ).all(id) as Record<string, unknown>[];

    const runs = rows.map((r) => ({
      id: r.id,
      skillId: r.skill_id,
      tenantId: r.tenant_id,
      instanceId: r.instance_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      outputJson: r.output_json,
      error: r.error,
    }));

    return new Response(JSON.stringify(ok({ runs })), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify(ok({ error: String(e) })), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}