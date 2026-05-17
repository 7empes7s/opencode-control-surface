import { getTenantSettings, updateTenantSettings, type TenantSettings } from "../tenancy/settings.ts";
import { getTenantContext } from "../tenancy/context.ts";
import { ok, type ApiEnvelope } from "./types.ts";

export function tenantSettingsGetHandler(req: Request): Response {
  const ctx = getTenantContext(req);
  const settings = getTenantSettings(ctx.tenantId);

  const envelope: ApiEnvelope<TenantSettings> = ok(settings);
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function tenantSettingsPutHandler(req: Request): Promise<Response> {
  const ctx = getTenantContext(req);
  const body = await req.json().catch(() => ({})) as Partial<TenantSettings>;

  try {
    const settings = updateTenantSettings(ctx.tenantId, body);
    const envelope: ApiEnvelope<TenantSettings> = ok(settings);
    return new Response(JSON.stringify(envelope), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}