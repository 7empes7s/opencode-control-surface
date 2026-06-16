import { createHash } from "node:crypto";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { readActionAudit, type ActionAuditRow } from "../db/writer.ts";
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
