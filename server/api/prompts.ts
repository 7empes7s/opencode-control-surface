import { checkToken } from "./actions.ts";
import { getCurrentTenantContext, tenantStore } from "../tenancy/middleware.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import { getPrompt, listPrompts } from "../prompts/registry.ts";

export function promptsHandler(req: Request, url: URL): Response {
  if (!checkToken(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const tenant = getCurrentTenantContext();
  const nameParam = url.searchParams.get("name");
  const versionParam = url.searchParams.get("version");

  return tenantStore.run({ ...tenant }, () => {
    if (nameParam) {
      const version = versionParam ? Number.parseInt(versionParam, 10) : undefined;
      const prompt = getPrompt(nameParam, { tenantId: tenant.tenantId, version: Number.isFinite(version) ? version : undefined });
      if (!prompt) {
        const body: ApiEnvelope<{ prompts: unknown[]; latest: null }> = ok(
          { prompts: listPrompts({ tenantId: tenant.tenantId }), latest: null },
          { prompts: "ok" },
        );
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body: ApiEnvelope<{ prompts: unknown[]; latest: typeof prompt }> = ok(
        { prompts: listPrompts({ tenantId: tenant.tenantId }), latest: prompt },
        { prompts: "ok" },
      );
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body: ApiEnvelope<{ prompts: ReturnType<typeof listPrompts>; latest: null }> = ok(
      { prompts: listPrompts({ tenantId: tenant.tenantId }), latest: null },
      { prompts: "ok" },
    );
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}
