import { getDashboardDb } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { getAuthenticatedUser } from "../auth/session.ts";
import { requireMutation } from "../governance/rbac.ts";
import { checkToken } from "./actions.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import {
  discoverAiAssets,
  listDiscoveredAssets,
  reconcileDiscoveredAssets,
  type DiscoveredAsset,
  type DiscoveredAssetStatus,
} from "../discovery/reconcile.ts";
import { resolveDiscoveryInsightsForAsset } from "../insights/store.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function notFound(msg = "Asset not found"): Response {
  return json({ error: msg }, 404);
}

function actor(req: Request): string {
  return getAuthenticatedUser(req)?.userId ?? "anonymous";
}

function setRegistered(
  db: NonNullable<ReturnType<typeof getDashboardDb>>,
  assetId: string,
  tenantId: string,
  registeredName: string | null,
  owner: string | null,
  criticality: DiscoveredAsset["criticality"],
  attachedService: string | null,
  now: number,
): void {
  const tenant = whereTenant();
  db.query(`
    UPDATE discovered_assets
    SET status = 'registered', registered_name = ?, owner = ?, criticality = ?,
        attached_service = ?, ignored_reason = NULL, updated_at = ?
    WHERE id = ? AND tenant_id = ? ${tenant.clause}
  `).run(registeredName, owner, criticality, attachedService, now, assetId, tenantId, ...tenant.params);
}

function setIgnored(
  db: NonNullable<ReturnType<typeof getDashboardDb>>,
  assetId: string,
  tenantId: string,
  reason: string | null,
  now: number,
): void {
  const tenant = whereTenant();
  db.query(`
    UPDATE discovered_assets
    SET status = 'ignored', ignored_reason = ?,
        registered_name = NULL, owner = NULL, criticality = NULL,
        attached_service = NULL, updated_at = ?
    WHERE id = ? AND tenant_id = ? ${tenant.clause}
  `).run(reason, now, assetId, tenantId, ...tenant.params);
}

// GET /api/discovery/assets?status=
export function discoveryListAssetsHandler(req: Request, url: URL): Response {
  if (!checkToken(req)) return unauthorized();

  const statusParam = url.searchParams.get("status") as DiscoveredAssetStatus | null;
  const valid = new Set<DiscoveredAssetStatus>(["unregistered", "registered", "ignored"]);
  const status = statusParam && valid.has(statusParam) ? statusParam : undefined;

  const assets = listDiscoveredAssets(status);
  const envelope: ApiEnvelope<DiscoveredAsset[]> = ok(assets);
  return json(envelope);
}

// POST /api/discovery/assets/:id/register
export async function discoveryRegisterAssetHandler(req: Request, assetId: string): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;

  const db = getDashboardDb();
  if (!db) return json({ error: "database unavailable" }, 503);

  const { tenantId } = getCurrentTenantContext();
  const tenant = whereTenant();

  const existing = db.query(`
    SELECT id, status FROM discovered_assets
    WHERE id = ? AND tenant_id = ? ${tenant.clause}
  `).get(assetId, tenantId, ...tenant.params) as { id: string; status: string } | null;

  if (!existing) return notFound();

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {}

  const registeredName = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  const owner = typeof body.owner === "string" && body.owner.trim() ? body.owner.trim() : null;
  const validCriticalities = new Set(["low", "medium", "high", "critical"]);
  const criticality = typeof body.criticality === "string" && validCriticalities.has(body.criticality)
    ? (body.criticality as DiscoveredAsset["criticality"])
    : null;
  const attachedService = typeof body.attachedService === "string" && body.attachedService.trim()
    ? body.attachedService.trim()
    : null;

  const now = Date.now();
  setRegistered(db, assetId, tenantId, registeredName, owner, criticality, attachedService, now);

  const resolved = resolveDiscoveryInsightsForAsset(assetId, `Operator registered asset${registeredName ? ` as "${registeredName}"` : ""}.`);

  try {
    writeActionAudit({
      actor: actor(req),
      actionKind: "discovery.asset.register",
      targetType: "discovered_asset",
      targetId: assetId,
      risk: "medium",
      resultStatus: "success",
      result: `Asset registered; ${resolved} insight(s) resolved.`,
      request: { name: registeredName, owner, criticality, attachedService },
    });
  } catch {}

  const updated = listDiscoveredAssets().find((a) => a.id === assetId) ?? null;
  return json(ok({ asset: updated, insightsResolved: resolved }));
}

// POST /api/discovery/assets/:id/ignore
export async function discoveryIgnoreAssetHandler(req: Request, assetId: string): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;

  const db = getDashboardDb();
  if (!db) return json({ error: "database unavailable" }, 503);

  const { tenantId } = getCurrentTenantContext();
  const tenant = whereTenant();

  const existing = db.query(`
    SELECT id FROM discovered_assets
    WHERE id = ? AND tenant_id = ? ${tenant.clause}
  `).get(assetId, tenantId, ...tenant.params) as { id: string } | null;

  if (!existing) return notFound();

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {}

  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  const now = Date.now();
  setIgnored(db, assetId, tenantId, reason, now);

  const resolved = resolveDiscoveryInsightsForAsset(assetId, `Operator ignored asset${reason ? `: ${reason}` : "."}`);

  try {
    writeActionAudit({
      actor: actor(req),
      actionKind: "discovery.asset.ignore",
      targetType: "discovered_asset",
      targetId: assetId,
      risk: "low",
      resultStatus: "success",
      result: `Asset ignored; ${resolved} insight(s) resolved.`,
      request: { reason },
    });
  } catch {}

  return json(ok({ ignored: true, insightsResolved: resolved }));
}

// POST /api/discovery/rescan
export function discoveryRescanHandler(req: Request): Response {
  const denied = requireMutation(req);
  if (denied) return denied;

  const now = Date.now();
  let assetsFound = 0;
  let error: string | null = null;

  try {
    const found = discoverAiAssets();
    assetsFound = found.length;
    reconcileDiscoveredAssets(found, now);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  try {
    writeActionAudit({
      actor: actor(req),
      actionKind: "discovery.rescan",
      targetType: "discovery",
      targetId: "all",
      risk: "low",
      resultStatus: error ? "error" : "success",
      result: error ?? `Rescan complete — ${assetsFound} asset(s) discovered.`,
    });
  } catch {}

  if (error) return json({ error }, 500);
  return json(ok({ assetsFound, scannedAt: now }));
}
