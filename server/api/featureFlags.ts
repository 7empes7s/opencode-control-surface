import { ok, type ApiEnvelope } from "./types.ts";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { getCurrentAuthenticatedUser } from "../auth/session.ts";
import {
  listFlags,
  getFlag,
  createFlag,
  updateFlag,
  toggleFlag,
  deleteFlag,
  getFlagHistory,
  type FeatureFlag,
  type FeatureFlagHistory,
} from "../featureflags/store.ts";

function notEnabled(): Response {
  return new Response(JSON.stringify({ ok: false, error: "dashboard db not enabled" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(msg = "feature flag not found"): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function badRequest(msg: string): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function resolveActor(req: Request): string {
  const user = getCurrentAuthenticatedUser();
  return user?.email ?? user?.name ?? "operator";
}

export async function featureFlagsListHandler(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) return notEnabled();
  const flags = listFlags();
  const envelope: ApiEnvelope<{ flags: FeatureFlag[] }> = ok({ flags });
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

export async function featureFlagsCreateHandler(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) return notEnabled();
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return badRequest("invalid JSON body");
  }
  const key = typeof body.key === "string" ? body.key.trim() : null;
  if (!key) return badRequest("key is required");
  if (!/^[a-z0-9_.-]+$/i.test(key)) return badRequest("key must be alphanumeric (a-z, 0-9, _, ., -)");
  const rolloutPercentage = typeof body.rolloutPercentage === "number" ? body.rolloutPercentage : 0;
  if (rolloutPercentage < 0 || rolloutPercentage > 100) return badRequest("rolloutPercentage must be 0-100");

  const actor = resolveActor(req);
  let flag: FeatureFlag;
  try {
    flag = createFlag({
      key,
      label: typeof body.label === "string" ? body.label : null,
      description: typeof body.description === "string" ? body.description : null,
      enabled: body.enabled === true,
      rolloutPercentage,
      targetingJson: body.targetingJson !== undefined ? body.targetingJson : undefined,
      createdBy: actor,
    }, actor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE constraint")) return badRequest("a flag with that key already exists");
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  writeActionAudit({
    actionKind: "feature-flags.create",
    actionId: `feature-flags.create:${flag.id}`,
    targetType: "feature-flag",
    targetId: flag.id,
    risk: "low",
    request: { key: flag.key, enabled: flag.enabled, rolloutPercentage: flag.rolloutPercentage },
    result: `feature flag ${flag.key} created`,
    resultStatus: "success",
  });

  return new Response(JSON.stringify({ ok: true, flag, message: `feature flag ${flag.key} created` }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

export async function featureFlagsGetHandler(req: Request, id: string): Promise<Response> {
  if (!isDashboardDbEnabled()) return notEnabled();
  const flag = getFlag(id);
  if (!flag) return notFound();
  const history = getFlagHistory(id);
  const envelope: ApiEnvelope<{ flag: FeatureFlag; history: FeatureFlagHistory[] }> = ok({ flag, history });
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

export async function featureFlagsUpdateHandler(req: Request, id: string): Promise<Response> {
  if (!isDashboardDbEnabled()) return notEnabled();
  const existing = getFlag(id);
  if (!existing) return notFound();

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return badRequest("invalid JSON body");
  }

  if (body.key !== undefined) {
    const k = typeof body.key === "string" ? body.key.trim() : "";
    if (!k || !/^[a-z0-9_.-]+$/i.test(k)) return badRequest("key must be alphanumeric (a-z, 0-9, _, ., -)");
  }
  if (body.rolloutPercentage !== undefined) {
    const pct = Number(body.rolloutPercentage);
    if (pct < 0 || pct > 100) return badRequest("rolloutPercentage must be 0-100");
  }

  const actor = resolveActor(req);

  // If only "enabled" is in the body with no other fields, use the fast toggle path
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "enabled" && typeof body.enabled === "boolean") {
    const updated = toggleFlag(id, body.enabled, actor);
    if (!updated) return notFound();
    writeActionAudit({
      actionKind: "feature-flags.toggle",
      actionId: `feature-flags.toggle:${id}`,
      targetType: "feature-flag",
      targetId: id,
      risk: "low",
      request: { enabled: body.enabled },
      result: `feature flag ${updated.key} ${body.enabled ? "enabled" : "disabled"}`,
      resultStatus: "success",
    });
    return new Response(JSON.stringify({ ok: true, flag: updated, message: `flag ${updated.key} ${body.enabled ? "enabled" : "disabled"}` }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const updated = updateFlag(id, {
    key: typeof body.key === "string" ? body.key.trim() : undefined,
    label: body.label !== undefined ? (typeof body.label === "string" ? body.label : null) : undefined,
    description: body.description !== undefined ? (typeof body.description === "string" ? body.description : null) : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    rolloutPercentage: typeof body.rolloutPercentage === "number" ? body.rolloutPercentage : undefined,
    targetingJson: body.targetingJson !== undefined ? body.targetingJson : undefined,
  }, actor);

  if (!updated) return notFound();

  writeActionAudit({
    actionKind: "feature-flags.update",
    actionId: `feature-flags.update:${id}`,
    targetType: "feature-flag",
    targetId: id,
    risk: "low",
    request: body,
    result: `feature flag ${updated.key} updated`,
    resultStatus: "success",
  });

  return new Response(JSON.stringify({ ok: true, flag: updated, message: `flag ${updated.key} updated` }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function featureFlagsDeleteHandler(req: Request, id: string): Promise<Response> {
  if (!isDashboardDbEnabled()) return notEnabled();
  const existing = getFlag(id);
  if (!existing) return notFound();

  const actor = resolveActor(req);
  const deleted = deleteFlag(id, actor);
  if (!deleted) return notFound();

  writeActionAudit({
    actionKind: "feature-flags.delete",
    actionId: `feature-flags.delete:${id}`,
    targetType: "feature-flag",
    targetId: id,
    risk: "medium",
    request: { key: existing.key },
    result: `feature flag ${existing.key} deleted`,
    resultStatus: "success",
  });

  return new Response(JSON.stringify({ ok: true, message: `flag ${existing.key} deleted` }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function featureFlagsHistoryHandler(req: Request, id: string): Promise<Response> {
  if (!isDashboardDbEnabled()) return notEnabled();
  const flag = getFlag(id);
  if (!flag) return notFound();
  const history = getFlagHistory(id);
  const envelope: ApiEnvelope<{ history: FeatureFlagHistory[] }> = ok({ history });
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}
