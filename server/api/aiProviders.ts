import { getAuthenticatedUser } from "../auth/session.ts";
import {
  createAiProviderVendorGroup,
  deleteAiProviderVendorGroup,
  deleteAiProviderVendorGroupRule,
  listAiProviderRegister,
  saveAiProviderDeclaration,
  saveAiProviderVendorGroupRule,
  updateAiProviderVendorGroup,
} from "../compliance/aiProviders.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { requireInsightPermission } from "./insights.ts";
import { ok } from "./types.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function aiProviderRegisterListHandler(req: Request): Response {
  const denied = requireInsightPermission(req, "insights.view");
  if (denied) return denied;
  return json(ok(listAiProviderRegister(getCurrentTenantContext())));
}

export async function aiProviderRegisterUpdateHandler(req: Request, providerKey: string): Promise<Response> {
  const denied = requireInsightPermission(req, "insights.apply");
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const result = saveAiProviderDeclaration(
    providerKey,
    body,
    getAuthenticatedUser(req)?.userId ?? null,
    getCurrentTenantContext(),
  );
  if (result.ok === false) return json({ error: result.error }, result.status);
  return json(ok({ provider: result.provider }));
}

async function requestBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, response: json({ error: "invalid json" }, 400) };
  }
}

function mutationActor(req: Request): string | null {
  return getAuthenticatedUser(req)?.userId ?? null;
}

export async function aiProviderVendorGroupCreateHandler(req: Request): Promise<Response> {
  const denied = requireInsightPermission(req, "insights.apply");
  if (denied) return denied;
  const parsed = await requestBody(req);
  if (parsed.ok === false) return parsed.response;
  const result = createAiProviderVendorGroup(parsed.body, mutationActor(req), getCurrentTenantContext());
  if (result.ok === false) return json({ error: result.error }, result.status);
  return json(ok({ vendorGroup: result.vendorGroup }), 201);
}

export async function aiProviderVendorGroupUpdateHandler(req: Request, groupKey: string): Promise<Response> {
  const denied = requireInsightPermission(req, "insights.apply");
  if (denied) return denied;
  const parsed = await requestBody(req);
  if (parsed.ok === false) return parsed.response;
  const result = updateAiProviderVendorGroup(groupKey, parsed.body, mutationActor(req), getCurrentTenantContext());
  if (result.ok === false) return json({ error: result.error }, result.status);
  return json(ok({ vendorGroup: result.vendorGroup }));
}

export function aiProviderVendorGroupDeleteHandler(req: Request, groupKey: string): Response {
  const denied = requireInsightPermission(req, "insights.apply");
  if (denied) return denied;
  const result = deleteAiProviderVendorGroup(groupKey, getCurrentTenantContext());
  if (result.ok === false) return json({ error: result.error }, result.status);
  return json(ok({ groupKey: result.groupKey }));
}

export async function aiProviderVendorGroupRuleCreateHandler(req: Request, groupKey: string): Promise<Response> {
  const denied = requireInsightPermission(req, "insights.apply");
  if (denied) return denied;
  const parsed = await requestBody(req);
  if (parsed.ok === false) return parsed.response;
  const result = saveAiProviderVendorGroupRule(groupKey, parsed.body, mutationActor(req), getCurrentTenantContext());
  if (result.ok === false) return json({ error: result.error }, result.status);
  return json(ok({ rule: result.rule, vendorGroup: result.vendorGroup }), 201);
}

export function aiProviderVendorGroupRuleDeleteHandler(req: Request, groupKey: string, ruleId: string): Response {
  const denied = requireInsightPermission(req, "insights.apply");
  if (denied) return denied;
  const result = deleteAiProviderVendorGroupRule(groupKey, ruleId, getCurrentTenantContext());
  if (result.ok === false) return json({ error: result.error }, result.status);
  return json(ok({ ruleId: result.ruleId, vendorGroup: result.vendorGroup }));
}
