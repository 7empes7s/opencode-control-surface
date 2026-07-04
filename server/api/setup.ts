// First-run setup wizard stub (ULTRAPLAN P0.5 / SPEC 5).
//
// GET  /api/setup/state    -> { needsSetup: boolean }
// POST /api/setup/complete -> renames the seed tenant + writes a marker row
//
// Markers live in the existing system_configs key/value table (Phase 7 — see
// server/api/systemConfig.ts) rather than a new table/framework:
//
//   setup.pending    written ONCE, at database birth, by migrateDashboardDb
//                    (only when the tenants table was empty before seeding —
//                    something only a brand-new database file ever exhibits).
//   setup.completed  written by POST /api/setup/complete.
//
// needsSetup is true only while the pending marker exists, no completed
// marker exists, and the seed tenant still carries the literal seed-default
// name (SEED_DEFAULT_TENANT_NAME — the same constant the seed itself uses,
// so the comparison can never drift from what's actually written).
//
// This is deliberately NOT an activity heuristic. The server autonomously
// writes rows on every boot (the ingestor fills metric_samples, the insights
// scanner fills insights — within seconds, even on a factory-fresh host), so
// "does the DB contain rows?" cannot distinguish a used install from a
// once-booted one. The birth marker can: a database that predates this
// feature (e.g. THIS production host, whose tenant is still literally named
// MIMULE) never receives the pending marker, so it can never be asked to
// "set up" again — while a genuinely fresh install keeps showing the wizard
// across sessions until the operator completes it, no matter how much
// background machinery has run in the meantime.
import {
  getDashboardDb,
  isDashboardDbEnabled,
  SEED_DEFAULT_TENANT_ID,
  SEED_DEFAULT_TENANT_NAME,
  SETUP_COMPLETED_MARKER_KEY,
  SETUP_PENDING_MARKER_KEY,
} from "../db/dashboard.ts";
import { writeActionAudit } from "../db/writer.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import type { Database } from "bun:sqlite";

const MAX_TENANT_NAME_LEN = 120;

export type SetupState = { needsSetup: boolean };

function hasMarker(db: Database, key: string): boolean {
  try {
    return db.query(`SELECT 1 FROM system_configs WHERE key = ?`).get(key) != null;
  } catch {
    return false;
  }
}

export function computeNeedsSetup(): boolean {
  if (!isDashboardDbEnabled()) return false;
  const db = getDashboardDb();
  if (!db) return false;

  if (hasMarker(db, SETUP_COMPLETED_MARKER_KEY)) return false;
  if (!hasMarker(db, SETUP_PENDING_MARKER_KEY)) return false; // predates this feature -> already set up

  // Renamed through some other path (tenants API) without completing the
  // wizard? Then setup is effectively done — don't nag.
  const tenant = db.query(`SELECT name FROM tenants WHERE id = ?`).get(SEED_DEFAULT_TENANT_ID) as { name: string } | null;
  return tenant != null && tenant.name === SEED_DEFAULT_TENANT_NAME;
}

export function setupStateHandler(): Response {
  const envelope: ApiEnvelope<SetupState> = ok({ needsSetup: computeNeedsSetup() });
  return Response.json(envelope);
}

export async function setupCompleteHandler(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return Response.json({ error: "dashboard database not enabled" }, { status: 503 });
  }
  const db = getDashboardDb();
  if (!db) {
    return Response.json({ error: "dashboard database not available" }, { status: 503 });
  }

  let body: { tenantName?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const tenantName = typeof body.tenantName === "string" ? body.tenantName.trim() : "";
  if (!tenantName || tenantName.length > MAX_TENANT_NAME_LEN) {
    return Response.json({ error: `tenantName is required (1-${MAX_TENANT_NAME_LEN} chars)` }, { status: 400 });
  }

  const now = Date.now();

  db.query(`UPDATE tenants SET name = ?, updated_at = ? WHERE id = ?`)
    .run(tenantName, now, SEED_DEFAULT_TENANT_ID);

  db.query(`
    INSERT OR REPLACE INTO system_configs (key, value_json, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
  `).run(SETUP_COMPLETED_MARKER_KEY, JSON.stringify({ completed: true, tenantName, completedAt: now }), now, "operator");

  writeActionAudit({
    actionKind: "setup.complete",
    actionId: "setup:complete",
    targetType: "tenant",
    targetId: SEED_DEFAULT_TENANT_ID,
    risk: "low",
    request: { tenantName },
    result: `tenant renamed to "${tenantName}"`,
    resultStatus: "success",
    resultJson: { tenantName },
    evidence: [{ label: "Tenant record", kind: "db", ref: "tenants" }],
    rollbackHint: "Rename the tenant again from /settings if this was a mistake.",
  });

  const envelope: ApiEnvelope<{ ok: true; tenantName: string }> = ok({ ok: true, tenantName });
  return Response.json(envelope);
}
