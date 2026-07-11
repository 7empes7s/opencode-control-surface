import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { listSubprocessors, getSoc2Mapping } from "./generator.ts";
import { getTenantSettings } from "../tenancy/settings.ts";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { readActionAudit, type ActionAuditRow } from "../db/writer.ts";
import { verifyChain } from "../db/audit/chain.ts";
import { whereTenant } from "../db/tenantScope.ts";
import { getAssetDisplayName, listDiscoveredAssets } from "../discovery/reconcile.ts";
import { computeTrustScore, type TrustScore } from "../security/score.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

export type EvidenceAuditRow = {
  ts: number;
  actor: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  result_status: string | null;
};

export type EvidenceAccessReviewUser = {
  id: string;
  email: string;
  role: string | null;
};

export type EvidenceAccessReviewKey = {
  id: string;
  agent_id: string;
  status: string;
  last_used_at: number | null;
};

export type EvidenceAccessReview = {
  users: EvidenceAccessReviewUser[];
  gatewayKeys: EvidenceAccessReviewKey[];
};

export type EvidenceCounts = {
  insights: number;
  action_audit: number;
  cost_events: number;
};

export type EvidencePack = {
  id: string;
  generatedAt: number;
  tenant: string;
  auditChain: {
    rows: EvidenceAuditRow[];
    chainSha256: string;
  };
  accessReview: EvidenceAccessReview;
  trustScore: TrustScore;
  counts: EvidenceCounts;
};

export type EvidencePackHeader = {
  id: number;
  ts: number;
  kind: string;
  path: string;
  summary: string | null;
};

const AUDIT_LIMIT = 500;
const EVIDENCE_PACK_KIND = "evidence-pack";

function redactAuditRows(rows: ActionAuditRow[]): EvidenceAuditRow[] {
  return rows.map((row) => ({
    ts: row.ts,
    actor: row.actor,
    action: row.actionKind,
    target_type: row.targetType,
    target_id: row.targetId,
    result_status: row.resultStatus,
  }));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildAccessReview(db: ReturnType<typeof getDashboardDb>): EvidenceAccessReview {
  if (!db) {
    return { users: [], gatewayKeys: [] };
  }

  let users: EvidenceAccessReviewUser[] = [];
  try {
    const userRows = db
      .query(
        `SELECT u.id AS id, u.email AS email, grb.role AS role
         FROM users u
         LEFT JOIN governance_role_bindings grb ON grb.user_id = u.id`
      )
      .all() as Array<{ id: string; email: string; role: string | null }>;
    users = userRows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
    }));
  } catch (err) {
    console.error("[evidence-pack] failed to read users", err);
  }

  let gatewayKeys: EvidenceAccessReviewKey[] = [];
  try {
    const keyRows = db
      .query(
        `SELECT id, agent_id, status, last_used_at FROM gateway_keys`
      )
      .all() as Array<{
      id: string;
      agent_id: string;
      status: string;
      last_used_at: number | null;
    }>;
    gatewayKeys = keyRows.map((row) => ({
      id: row.id,
      agent_id: row.agent_id,
      status: row.status,
      last_used_at: row.last_used_at,
    }));
  } catch (err) {
    console.error("[evidence-pack] failed to read gateway keys", err);
  }

  return { users, gatewayKeys };
}

function buildCounts(db: ReturnType<typeof getDashboardDb>): EvidenceCounts {
  if (!db) {
    return { insights: 0, action_audit: 0, cost_events: 0 };
  }

  function safeCount(sql: string): number {
    try {
      const row = db!.query(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  return {
    insights: safeCount("SELECT COUNT(*) AS n FROM insights"),
    action_audit: safeCount("SELECT COUNT(*) AS n FROM action_audit"),
    cost_events: safeCount("SELECT COUNT(*) AS n FROM cost_events"),
  };
}

function buildPackFromDb(): { pack: Omit<EvidencePack, "id">; chainSha256: string } {
  const db = isDashboardDbEnabled() ? getDashboardDb() : null;
  const tenant = getCurrentTenantContext().tenantId;

  const auditRows = db ? readActionAudit({ limit: AUDIT_LIMIT }) : [];
  const redactedRows = redactAuditRows(auditRows);
  const chainSha256 = sha256Hex(JSON.stringify(redactedRows));

  const accessReview = buildAccessReview(db);
  const trustScore = computeTrustScore();
  const counts = buildCounts(db);

  return {
    pack: {
      generatedAt: Date.now(),
      tenant,
      auditChain: {
        rows: redactedRows,
        chainSha256,
      },
      accessReview,
      trustScore,
      counts,
    },
    chainSha256,
  };
}

export function generateEvidencePack(): { id: string } {
  const { pack } = buildPackFromDb();

  const db = isDashboardDbEnabled() ? getDashboardDb() : null;
  if (!db) {
    return { id: "db-off" };
  }

  const packId = crypto.randomUUID();
  const path = `compliance/evidence-pack/${packId}`;
  const summary = JSON.stringify(pack);

  try {
    const result = db
      .query(
        `INSERT INTO report_archive (ts, kind, path, summary)
         VALUES (?, ?, ?, ?)`
      )
      .run(pack.generatedAt, EVIDENCE_PACK_KIND, path, summary);
    const rowId = String(result.lastInsertRowid);
    return { id: rowId };
  } catch (err) {
    console.error("[evidence-pack] failed to persist pack", err);
    return { id: "db-off" };
  }
}

export function readEvidencePackById(id: string): EvidencePack | null {
  const db = isDashboardDbEnabled() ? getDashboardDb() : null;
  if (!db) {
    return null;
  }

  const numericId = Number.parseInt(id, 10);
  if (!Number.isFinite(numericId)) {
    return null;
  }

  const row = db
    .query(`SELECT id, ts, kind, path, summary FROM report_archive WHERE id = ?`)
    .get(numericId) as EvidencePackHeader | null;

  if (!row || row.kind !== EVIDENCE_PACK_KIND || !row.summary) {
    return null;
  }

  try {
    const stored = JSON.parse(row.summary) as Omit<EvidencePack, "id">;
    return { id: String(row.id), ...stored };
  } catch (err) {
    console.error("[evidence-pack] failed to parse stored pack", err);
    return null;
  }
}

export function buildEvidencePackInMemory(): { pack: Omit<EvidencePack, "id">; chainSha256: string } {
  return buildPackFromDb();
}

export type Configured<T> = ({ configured: true } & T) | { configured: false };

export type ComplianceControlStatuses = {
  tenantId: string;
  dataResidencyRegion: string;
  auditRetentionDays: number;
  requireTwoApprovers: boolean;
  ssoRequired: boolean;
  subprocessorCount: number;
  soc2ControlCount: number;
};

export type EvidenceAuditChainSegment = Configured<{
  cap: 2000;
  capped: boolean;
  rows: EvidenceAuditRow[];
  chainVerification: {
    ok: boolean;
    brokenAt: number | null;
    checkedCount: number;
  };
}>;

export type EvidenceModelLifecycleRecord = {
  logicalName: string;
  firstSeen: number;
  lastEval: number;
  evalHistory: Array<{
    ts: number;
    score: number | null;
    latencyMs: number | null;
    error: string | null;
  }>;
};

export type EvidencePostMortem = {
  id: string;
  title: string;
  failureClass: string;
  resolvedAt: number | null;
  postMortem: string;
};

export type EvidenceDiscoveryAsset = {
  id: string;
  kind: string;
  name: string;
  status: string;
  criticality: string | null;
  owner: string | null;
  lastSeen: number;
};

export type EvidencePackV2 = Omit<EvidencePack, "id"> & {
  period: { from: number; to: number };
  auditChainSegment: EvidenceAuditChainSegment;
  controlStatuses: Configured<ComplianceControlStatuses>;
  modelLifecycle: Configured<{ records: EvidenceModelLifecycleRecord[] }>;
  postmortems: Configured<{ records: EvidencePostMortem[] }>;
  discoveryInventory: Configured<{
    assets: EvidenceDiscoveryAsset[];
    countsByStatus: Record<string, number>;
  }>;
};

const AUDIT_SEGMENT_LIMIT = 2000;

type AuditSegmentDbRow = {
  id: number;
  ts: number;
  actor: string | null;
  action_kind: string;
  target_type: string | null;
  target_id: string | null;
  result_status: string | null;
  prev_hash: string | null;
  row_hash: string | null;
  tenant_id: string | null;
};

export function buildComplianceControlStatuses(tenantId: string): ComplianceControlStatuses {
  const settings = getTenantSettings(tenantId);
  const subprocessors = listSubprocessors();
  const mapping = getSoc2Mapping();
  return {
    tenantId,
    dataResidencyRegion: settings.dataResidencyRegion,
    auditRetentionDays: settings.auditRetentionDays,
    requireTwoApprovers: settings.requireTwoApprovers,
    ssoRequired: settings.ssoRequired,
    subprocessorCount: subprocessors.length,
    soc2ControlCount: mapping.filter((item) =>
      item.criteria.startsWith("CC6") || item.criteria.startsWith("CC7") ||
      item.criteria.startsWith("CC8") || item.criteria.startsWith("CC9")
    ).length,
  };
}

function verifyAuditSegment(rows: AuditSegmentDbRow[]): {
  ok: boolean;
  brokenAt: number | null;
  checkedCount: number;
} {
  const chainedRows = rows.filter((row) => row.row_hash !== null);
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE action_audit (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      prev_hash TEXT,
      row_hash TEXT,
      tenant_id TEXT
    )`);

    if (chainedRows.length === 0) {
      const result = verifyChain(db, 0);
      return { ok: result.ok, brokenAt: result.firstBadId ?? null, checkedCount: result.checkedCount };
    }

    const first = chainedRows[0];
    const needsAnchor = first.prev_hash !== null && first.prev_hash !== "genesis";
    if (needsAnchor) {
      db.query(`INSERT INTO action_audit (id, ts, prev_hash, row_hash, tenant_id)
        VALUES (?, ?, 'genesis', ?, ?)`)
        .run(first.id - 1, first.ts - 1, first.prev_hash, first.tenant_id);
    }
    const insert = db.query(`INSERT INTO action_audit (id, ts, prev_hash, row_hash, tenant_id)
      VALUES (?, ?, ?, ?, ?)`);
    for (const row of chainedRows) {
      insert.run(row.id, row.ts, row.prev_hash, row.row_hash, row.tenant_id);
    }

    const result = verifyChain(db, chainedRows.length + (needsAnchor ? 1 : 0));
    return {
      ok: result.ok,
      brokenAt: result.firstBadId ?? null,
      checkedCount: Math.max(0, result.checkedCount - (needsAnchor ? 1 : 0)),
    };
  } finally {
    db.close();
  }
}

function collectAuditChainSegment(
  db: NonNullable<ReturnType<typeof getDashboardDb>>,
  periodStart: number,
  periodEnd: number,
): EvidenceAuditChainSegment {
  try {
    const tenant = whereTenant();
    const rows = db.query(`
      SELECT id, ts, actor, action_kind, target_type, target_id, result_status,
             prev_hash, row_hash, tenant_id
      FROM action_audit
      WHERE ts >= ? AND ts <= ? ${tenant.clause}
      ORDER BY id ASC
      LIMIT ?
    `).all(periodStart, periodEnd, ...tenant.params, AUDIT_SEGMENT_LIMIT + 1) as AuditSegmentDbRow[];
    const capped = rows.length > AUDIT_SEGMENT_LIMIT;
    const segmentRows = rows.slice(0, AUDIT_SEGMENT_LIMIT);
    const redactedRows = segmentRows.map((row) => ({
      ts: row.ts,
      actor: row.actor,
      action: row.action_kind,
      target_type: row.target_type,
      target_id: row.target_id,
      result_status: row.result_status,
    }));
    return {
      configured: true,
      cap: AUDIT_SEGMENT_LIMIT,
      capped,
      rows: redactedRows,
      chainVerification: verifyAuditSegment(segmentRows),
    };
  } catch {
    return { configured: false };
  }
}

function collectModelLifecycle(
  db: NonNullable<ReturnType<typeof getDashboardDb>>,
  periodStart: number,
  periodEnd: number,
): EvidencePackV2["modelLifecycle"] {
  try {
    const tenant = whereTenant();
    const rows = db.query(`
      SELECT ts, key, value_json
      FROM metric_samples
      WHERE source = 'model-eval' AND ts >= ? AND ts <= ? ${tenant.clause}
      ORDER BY key ASC, ts ASC
    `).all(periodStart, periodEnd, ...tenant.params) as Array<{
      ts: number;
      key: string;
      value_json: string;
    }>;
    if (rows.length === 0) return { configured: false };

    const grouped = new Map<string, EvidenceModelLifecycleRecord>();
    for (const row of rows) {
      let value: { ts?: unknown; score?: unknown; latencyMs?: unknown; error?: unknown } = {};
      try {
        value = JSON.parse(row.value_json) as typeof value;
      } catch {
        value = {};
      }
      const ts = typeof value.ts === "number" && Number.isFinite(value.ts)
        && value.ts >= periodStart && value.ts <= periodEnd
        ? value.ts
        : row.ts;
      const existing = grouped.get(row.key) ?? {
        logicalName: row.key,
        firstSeen: ts,
        lastEval: ts,
        evalHistory: [],
      };
      existing.firstSeen = Math.min(existing.firstSeen, ts);
      existing.lastEval = Math.max(existing.lastEval, ts);
      existing.evalHistory.push({
        ts,
        score: typeof value.score === "number" && Number.isFinite(value.score) ? value.score : null,
        latencyMs: typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) ? value.latencyMs : null,
        error: typeof value.error === "string" && value.error ? value.error : null,
      });
      grouped.set(row.key, existing);
    }
    return { configured: true, records: [...grouped.values()] };
  } catch {
    return { configured: false };
  }
}

function collectPostMortems(
  db: NonNullable<ReturnType<typeof getDashboardDb>>,
  periodStart: number,
  periodEnd: number,
): EvidencePackV2["postmortems"] {
  try {
    const tenant = whereTenant();
    const rows = db.query(`
      SELECT id, title, failure_class, resolved_at, post_mortem
      FROM reasoner_incidents
      WHERE post_mortem IS NOT NULL
        AND ((resolved_at >= ? AND resolved_at <= ?) OR (last_seen >= ? AND last_seen <= ?))
        ${tenant.clause}
      ORDER BY COALESCE(resolved_at, last_seen) ASC, id ASC
    `).all(periodStart, periodEnd, periodStart, periodEnd, ...tenant.params) as Array<{
      id: string;
      title: string;
      failure_class: string;
      resolved_at: number | null;
      post_mortem: string;
    }>;
    return {
      configured: true,
      records: rows.map((row) => ({
        id: row.id,
        title: row.title,
        failureClass: row.failure_class,
        resolvedAt: row.resolved_at,
        postMortem: row.post_mortem,
      })),
    };
  } catch {
    return { configured: false };
  }
}

function collectDiscoveryInventory(
  db: NonNullable<ReturnType<typeof getDashboardDb>>,
): EvidencePackV2["discoveryInventory"] {
  try {
    const assets = listDiscoveredAssets().map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.registeredName ?? getAssetDisplayName(asset),
      status: asset.status,
      criticality: asset.criticality,
      owner: asset.owner,
      lastSeen: asset.lastSeen,
    }));
    const countsByStatus: Record<string, number> = {};
    for (const asset of assets) {
      countsByStatus[asset.status] = (countsByStatus[asset.status] ?? 0) + 1;
    }
    return { configured: true, assets, countsByStatus };
  } catch {
    return { configured: false };
  }
}

export function buildEvidencePackV2(periodStart: number, periodEnd: number): EvidencePackV2 {
  const { pack } = buildPackFromDb();
  const db = isDashboardDbEnabled() ? getDashboardDb() : null;
  const tenantId = pack.tenant;

  return {
    ...pack,
    period: { from: periodStart, to: periodEnd },
    auditChainSegment: db
      ? collectAuditChainSegment(db, periodStart, periodEnd)
      : { configured: false },
    controlStatuses: {
      configured: true,
      ...buildComplianceControlStatuses(tenantId),
    },
    modelLifecycle: db
      ? collectModelLifecycle(db, periodStart, periodEnd)
      : { configured: false },
    postmortems: db
      ? collectPostMortems(db, periodStart, periodEnd)
      : { configured: false },
    discoveryInventory: db
      ? collectDiscoveryInventory(db)
      : { configured: false },
  };
}
