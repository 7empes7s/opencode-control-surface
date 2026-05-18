import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { checkToken } from "./actions.ts";

export function contextGetHandler(req: Request): Response {
  if (!checkToken(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ctx = getCurrentTenantContext();
  return new Response(
    JSON.stringify({
      tenantId: ctx.tenantId,
      projectId: ctx.projectId ?? null,
      actor: ctx.actor ?? null,
      source: ctx.source,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
