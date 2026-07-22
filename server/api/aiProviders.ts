import { getAuthenticatedUser } from "../auth/session.ts";
import { listAiProviderProfiles, saveAiProviderDeclaration } from "../compliance/aiProviders.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { requireInsightPermission } from "./insights.ts";
import { ok } from "./types.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function aiProviderRegisterListHandler(req: Request): Response {
  const denied = requireInsightPermission(req, "insights.view");
  if (denied) return denied;
  return json(ok({ providers: listAiProviderProfiles(getCurrentTenantContext()) }));
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
