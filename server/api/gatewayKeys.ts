import { checkToken } from "./actions.ts";
import { ok } from "./types.ts";
import {
  createGatewayKey,
  listGatewayKeys,
  revokeGatewayKey,
  type CreatedGatewayKey,
} from "../gateway/keys.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiError(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")) return {};
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function reasonFromBody(body: Record<string, unknown>): string | undefined {
  const reason = body.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
}

function auditKeys(input: Parameters<typeof writeActionAudit>[0]): void {
  const ctx = getCurrentTenantContext();
  writeActionAudit({
    actor: ctx.actor ?? "operator",
    actorSource: ctx.source,
    targetType: "gateway-key",
    risk: "medium",
    ...input,
  });
}

// GET /api/gateway/keys
export function listGatewayKeysHandler(req: Request): Response {
  if (!checkToken(req)) {
    return json({ error: "unauthorized" }, 401);
  }
  return json(ok({ keys: listGatewayKeys() }));
}

// POST /api/gateway/keys
export async function createGatewayKeyHandler(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!agentId) return apiError("agentId is required");
  if (!name) return apiError("name is required");

  const modelAllowlist = Array.isArray(body.modelAllowlist)
    ? body.modelAllowlist.filter((item): item is string => typeof item === "string")
    : undefined;
  const dailyCapUsd = typeof body.dailyCapUsd === "number" && Number.isFinite(body.dailyCapUsd)
    ? body.dailyCapUsd
    : undefined;

  let created: CreatedGatewayKey;
  try {
    created = createGatewayKey(agentId, name, {
      modelAllowlist,
      dailyCapUsd,
    });
  } catch (error) {
    return apiError(errorMessage(error), 400);
  }

  auditKeys({
    actionKind: "gateway.key-created",
    actionId: `gateway.key-created:${created.record.id}`,
    targetId: agentId,
    reason: reasonFromBody(body),
    request: { agentId, name, modelAllowlist, dailyCapUsd },
    resultStatus: "success",
    result: `issued gateway key ${created.record.id} for ${agentId}`,
  });

  return json(ok({
    key: created.key,
    record: created.record,
  }));
}

// POST /api/gateway/keys/:id/revoke
export async function revokeGatewayKeyHandler(req: Request, keyId: string): Promise<Response> {
  if (!keyId) return apiError("key id is required");
  const body = await readJsonBody(req);
  const revoked = revokeGatewayKey(keyId);
  if (!revoked) {
    return apiError(`Gateway key ${keyId} was not found or already revoked.`, 404);
  }
  auditKeys({
    actionKind: "gateway.key-revoked",
    actionId: `gateway.key-revoked:${keyId}`,
    targetId: keyId,
    reason: reasonFromBody(body),
    request: { keyId },
    resultStatus: "success",
    result: `revoked gateway key ${keyId}`,
  });
  return json(ok({ ok: true, keyId }));
}
