import { getDashboardDb } from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { getAuthenticatedUser } from "../auth/session.ts";
import { requireMutation } from "../governance/rbac.ts";
import { checkToken } from "./actions.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import {
  DISCOVERY_SOURCES,
  discoverAiAssets,
  listDiscoveredAssets,
  reconcileDiscoveredAssets,
  type DiscoveredAsset,
  type DiscoveredAssetStatus,
  type DiscoverySource,
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

type DashboardDb = NonNullable<ReturnType<typeof getDashboardDb>>;
type RegisterValues = {
  registeredName: string | null;
  owner: string | null;
  criticality: DiscoveredAsset["criticality"];
  attachedService: string | null;
};

const VALID_CRITICALITIES = new Set(["low", "medium", "high", "critical"]);

function registerValues(body: Record<string, unknown>, allowName = true): RegisterValues {
  return {
    registeredName: allowName && typeof body.name === "string" && body.name.trim() ? body.name.trim() : null,
    owner: typeof body.owner === "string" && body.owner.trim() ? body.owner.trim() : null,
    criticality: typeof body.criticality === "string" && VALID_CRITICALITIES.has(body.criticality)
      ? body.criticality as DiscoveredAsset["criticality"]
      : null,
    attachedService: typeof body.attachedService === "string" && body.attachedService.trim()
      ? body.attachedService.trim()
      : null,
  };
}

function assetExists(db: DashboardDb, assetId: string, tenantId: string): boolean {
  const tenant = whereTenant();
  return Boolean(db.query(`
    SELECT id FROM discovered_assets
    WHERE id = ? AND tenant_id = ? ${tenant.clause}
  `).get(assetId, tenantId, ...tenant.params));
}

function registerAssetCore(
  req: Request,
  db: DashboardDb,
  tenantId: string,
  assetId: string,
  values: RegisterValues,
  bulk = false,
): { asset: DiscoveredAsset | null; insightsResolved: number } | null {
  if (!assetExists(db, assetId, tenantId)) return null;

  const { registeredName, owner, criticality, attachedService } = values;
  setRegistered(db, assetId, tenantId, registeredName, owner, criticality, attachedService, Date.now());
  const insightsResolved = resolveDiscoveryInsightsForAsset(assetId, `Operator registered asset${registeredName ? ` as "${registeredName}"` : ""}.`);

  try {
    writeActionAudit({
      actor: actor(req),
      actionKind: "discovery.asset.register",
      targetType: "discovered_asset",
      targetId: assetId,
      risk: "medium",
      resultStatus: "success",
      result: `Asset registered; ${insightsResolved} insight(s) resolved.`,
      request: { name: registeredName, owner, criticality, attachedService, ...(bulk ? { bulk: true } : {}) },
    });
  } catch {}

  return {
    asset: listDiscoveredAssets().find((asset) => asset.id === assetId) ?? null,
    insightsResolved,
  };
}

function ignoreAssetCore(
  req: Request,
  db: DashboardDb,
  tenantId: string,
  assetId: string,
  reason: string | null,
  bulk = false,
): { ignored: true; insightsResolved: number } | null {
  if (!assetExists(db, assetId, tenantId)) return null;

  setIgnored(db, assetId, tenantId, reason, Date.now());
  const insightsResolved = resolveDiscoveryInsightsForAsset(assetId, `Operator ignored asset${reason ? `: ${reason}` : "."}`);

  try {
    writeActionAudit({
      actor: actor(req),
      actionKind: "discovery.asset.ignore",
      targetType: "discovered_asset",
      targetId: assetId,
      risk: "low",
      resultStatus: "success",
      result: `Asset ignored; ${insightsResolved} insight(s) resolved.`,
      request: { reason, ...(bulk ? { bulk: true } : {}) },
    });
  } catch {}

  return { ignored: true, insightsResolved };
}

function parseAssetIds(body: Record<string, unknown>): string[] | null {
  if (!Array.isArray(body.assetIds) || body.assetIds.length === 0 || body.assetIds.length > 100) return null;
  if (!body.assetIds.every((assetId) => typeof assetId === "string" && assetId.length > 0)) return null;
  return body.assetIds as string[];
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
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {}
  const result = registerAssetCore(req, db, tenantId, assetId, registerValues(body));
  if (!result) return notFound();
  return json(ok(result));
}

// POST /api/discovery/assets/:id/ignore
export async function discoveryIgnoreAssetHandler(req: Request, assetId: string): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;

  const db = getDashboardDb();
  if (!db) return json({ error: "database unavailable" }, 503);

  const { tenantId } = getCurrentTenantContext();
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {}

  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  const result = ignoreAssetCore(req, db, tenantId, assetId, reason);
  if (!result) return notFound();
  return json(ok(result));
}

export async function discoveryBulkRegisterHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;
  const db = getDashboardDb();
  if (!db) return json({ error: "database unavailable" }, 503);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {}
  const assetIds = parseAssetIds(body);
  if (!assetIds) return json({ error: "assetIds must be a non-empty string array with at most 100 items" }, 400);

  const { tenantId } = getCurrentTenantContext();
  const values = registerValues(body, false);
  let processed = 0;
  let insightsResolved = 0;
  const notFoundIds: string[] = [];
  for (const assetId of assetIds) {
    const result = registerAssetCore(req, db, tenantId, assetId, values, true);
    if (!result) notFoundIds.push(assetId);
    else {
      processed += 1;
      insightsResolved += result.insightsResolved;
    }
  }
  return json(ok({ processed, notFoundIds, insightsResolved }));
}

export async function discoveryBulkIgnoreHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;
  const db = getDashboardDb();
  if (!db) return json({ error: "database unavailable" }, 503);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {}
  const assetIds = parseAssetIds(body);
  if (!assetIds) return json({ error: "assetIds must be a non-empty string array with at most 100 items" }, 400);

  const { tenantId } = getCurrentTenantContext();
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  let processed = 0;
  let insightsResolved = 0;
  const notFoundIds: string[] = [];
  for (const assetId of assetIds) {
    const result = ignoreAssetCore(req, db, tenantId, assetId, reason, true);
    if (!result) notFoundIds.push(assetId);
    else {
      processed += 1;
      insightsResolved += result.insightsResolved;
    }
  }
  return json(ok({ processed, notFoundIds, insightsResolved }));
}

export async function discoveryUpdateAssetHandler(req: Request, assetId: string): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;
  const db = getDashboardDb();
  if (!db) return json({ error: "database unavailable" }, 503);

  const { tenantId } = getCurrentTenantContext();
  const tenant = whereTenant();
  const existing = db.query(`
    SELECT id, status, owner, criticality FROM discovered_assets
    WHERE id = ? AND tenant_id = ? ${tenant.clause}
  `).get(assetId, tenantId, ...tenant.params) as {
    id: string; status: DiscoveredAssetStatus; owner: string | null; criticality: DiscoveredAsset["criticality"];
  } | null;
  if (!existing) return notFound();
  if (existing.status !== "registered") return json({ error: "Only registered assets can be edited" }, 409);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {}
  const hasOwner = Object.prototype.hasOwnProperty.call(body, "owner");
  const hasCriticality = Object.prototype.hasOwnProperty.call(body, "criticality");
  if (!hasOwner && !hasCriticality) return json({ error: "owner or criticality is required" }, 400);
  if (hasCriticality && (typeof body.criticality !== "string" || !VALID_CRITICALITIES.has(body.criticality))) {
    return json({ error: "criticality must be low, medium, high, or critical" }, 400);
  }

  const owner = hasOwner
    ? (typeof body.owner === "string" && body.owner.trim() ? body.owner.trim() : null)
    : existing.owner;
  const criticality = hasCriticality ? body.criticality as DiscoveredAsset["criticality"] : existing.criticality;
  const before = { owner: existing.owner, criticality: existing.criticality };
  const after = { owner, criticality };
  db.query(`
    UPDATE discovered_assets SET owner = ?, criticality = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? ${tenant.clause}
  `).run(owner, criticality, Date.now(), assetId, tenantId, ...tenant.params);

  try {
    writeActionAudit({
      actor: actor(req),
      actionKind: "discovery.asset.update",
      targetType: "discovered_asset",
      targetId: assetId,
      risk: "low",
      resultStatus: "success",
      result: "Asset owner/criticality updated.",
      request: { before, after },
    });
  } catch {}
  const asset = listDiscoveredAssets().find((item) => item.id === assetId) ?? null;
  return json(ok({ asset }));
}

export function runDiscoveryScan(source?: DiscoverySource): { assetsFound: number; scannedAt: number } {
  const scannedAt = Date.now();
  const found = source ? DISCOVERY_SOURCES[source]() : discoverAiAssets();
  reconcileDiscoveredAssets(found, scannedAt);
  return { assetsFound: found.length, scannedAt };
}

// POST /api/discovery/rescan
export async function discoveryRescanHandler(req: Request): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {}
  const source = body.source;
  if (source !== undefined && (typeof source !== "string" || !Object.prototype.hasOwnProperty.call(DISCOVERY_SOURCES, source))) {
    return json({ error: "unknown discovery source" }, 400);
  }

  let scannedAt = Date.now();
  let assetsFound = 0;
  let error: string | null = null;

  try {
    const result = runDiscoveryScan(source as DiscoverySource | undefined);
    assetsFound = result.assetsFound;
    scannedAt = result.scannedAt;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("[discovery] probe failed", error);
  }

  try {
    writeActionAudit({
      actor: actor(req),
      actionKind: "discovery.rescan",
      targetType: "discovery",
      targetId: typeof source === "string" ? source : "all",
      risk: "low",
      resultStatus: error ? "error" : "success",
      result: error ?? `Rescan complete — ${assetsFound} asset(s) discovered.`,
    });
  } catch {}

  if (error) return json({ error }, 500);
  return json(ok({ assetsFound, scannedAt }));
}
