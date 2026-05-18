import { randomUUID } from "node:crypto";
import { getDashboardDb } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { whereTenant, tenantParams, withTenantInsert } from "../db/tenantScope.ts";
import type { TenantContext } from "../tenancy/context.ts";

export interface ApprovalVote {
  id: string;
  requestId: string;
  voter: string;
  decision: "approve" | "reject";
  comment?: string;
  votedAt: number;
}

export interface ApprovalRequest {
  id: string;
  workflowId: string;
  runId: string;
  tenantId: string;
  requestedAt: number;
  requestedBy?: string;
  status: "pending" | "approved" | "rejected" | "expired";
  approvals: ApprovalVote[];
  requiredCount: number;
  expiresAt?: number;
  decidedAt?: number;
  decidedBy?: string;
  decision?: "approved" | "rejected";
  reason?: string;
}

function parseApprovalsJson(json: string): ApprovalVote[] {
  try {
    return JSON.parse(json) as ApprovalVote[];
  } catch {
    return [];
  }
}

export function createApprovalRequest(
  workflowId: string,
  runId: string,
  requestedBy: string,
  requiredCount: number,
  expiresAt?: number,
  ctx?: TenantContext,
): ApprovalRequest {
  const db = getDashboardDb();
  if (!db) throw new Error("db not available");

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const tenantId = tenantCtx.tenantId;
  const id = `ar_${randomUUID()}`;
  const now = Date.now();

  const row = withTenantInsert(tenantCtx, {
    id,
    workflow_id: workflowId,
    run_id: runId,
    requested_at: now,
    requested_by: requestedBy,
    status: "pending",
    approvals_json: "[]",
    required_count: requiredCount,
    expires_at: expiresAt ?? null,
  });

  db.query(`
    INSERT INTO governance_approvals
      (id, workflow_id, run_id, tenant_id, requested_at, requested_by, status, approvals_json, required_count, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.workflow_id,
    row.run_id,
    row.tenant_id,
    row.requested_at,
    row.requested_by,
    row.status,
    row.approvals_json,
    row.required_count,
    row.expires_at,
  );

  return {
    id,
    workflowId,
    runId,
    tenantId,
    requestedAt: now,
    requestedBy,
    status: "pending",
    approvals: [],
    requiredCount,
    expiresAt,
  };
}

export function getApprovalRequest(id: string, ctx?: TenantContext): ApprovalRequest | null {
  const db = getDashboardDb();
  if (!db) return null;

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const { clause, params } = whereTenant(tenantCtx);

  const row = db.query(
    `SELECT * FROM governance_approvals WHERE id = ? ${clause}`
  ).get(id, ...params) as Record<string, unknown> | null;
  if (!row) return null;

  return mapRowToRequest(row);
}

function mapRowToRequest(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: row.id as string,
    workflowId: row.workflow_id as string,
    runId: row.run_id as string,
    tenantId: (row.tenant_id as string) ?? "",
    requestedAt: row.requested_at as number,
    requestedBy: row.requested_by as string | undefined,
    status: (row.status as "pending" | "approved" | "rejected" | "expired") ?? "pending",
    approvals: parseApprovalsJson(row.approvals_json as string),
    requiredCount: (row.required_count as number) ?? 1,
    expiresAt: row.expires_at as number | undefined,
    decidedAt: row.decided_at as number | undefined,
    decidedBy: row.decided_by as string | undefined,
    decision: row.decision as "approved" | "rejected" | undefined,
    reason: row.reason as string | undefined,
  };
}

export function listApprovalRequests(
  status?: "pending" | "approved" | "rejected" | "expired",
  ctx?: TenantContext,
): ApprovalRequest[] {
  const db = getDashboardDb();
  if (!db) return [];

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const { clause, params } = whereTenant(tenantCtx);

  let rows: Record<string, unknown>[];
  if (status) {
    rows = db
      .query(`SELECT * FROM governance_approvals WHERE status = ? ${clause} ORDER BY requested_at DESC`)
      .all(status, ...params) as Record<string, unknown>[];
  } else {
    rows = db
      .query(`SELECT * FROM governance_approvals WHERE 1=1 ${clause} ORDER BY requested_at DESC`)
      .all(...params) as Record<string, unknown>[];
  }

  return rows.map(mapRowToRequest);
}

export function submitVote(
  requestId: string,
  voter: string,
  decision: "approve" | "reject",
  comment?: string,
  ctx?: TenantContext,
): ApprovalRequest | null {
  const db = getDashboardDb();
  if (!db) return null;

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const req = getApprovalRequest(requestId, tenantCtx);
  if (!req) return null;
  if (req.status !== "pending") return req;
  if (req.expiresAt && Date.now() > req.expiresAt) {
    expireRequest(requestId);
    return getApprovalRequest(requestId, tenantCtx);
  }

  const voteId = `av_${randomUUID()}`;
  const now = Date.now();

  db.query(`
    INSERT INTO governance_approval_votes (id, request_id, voter, decision, comment, voted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(voteId, requestId, voter, decision, comment ?? null, now);

  const { clause: tenantClause, params: tenantParams } = whereTenant(tenantCtx);
  
  const existingVotes = db
    .query(`SELECT * FROM governance_approval_votes WHERE request_id = ?`)
    .all(requestId) as Record<string, unknown>[];

  const approvals: ApprovalVote[] = existingVotes.map((v) => ({
    id: v.id as string,
    requestId: v.request_id as string,
    voter: v.voter as string,
    decision: v.decision as "approve" | "reject",
    comment: v.comment as string | undefined,
    votedAt: v.voted_at as number,
  }));

  const approvers = new Set(
    approvals
      .filter((v) => v.decision === "approve")
      .map((v) => v.voter),
  );

  const rejected = approvals.some((v) => v.decision === "reject");

  let newStatus: "pending" | "approved" | "rejected" = "pending";
  if (rejected) {
    newStatus = "rejected";
  } else if (approvers.size >= req.requiredCount) {
    newStatus = "approved";
  }

  const approvalsJson = JSON.stringify(approvals);

  db.query(`
    UPDATE governance_approvals
    SET status = ?, approvals_json = ?, decided_at = ?, decided_by = ?, decision = ?
    WHERE id = ?
  `).run(newStatus, approvalsJson, now, voter, newStatus === "approved" ? "approved" : "rejected", requestId);

  return getApprovalRequest(requestId, tenantCtx);
}

export function expireStaleRequests(ctx?: TenantContext): number {
  const db = getDashboardDb();
  if (!db) return 0;

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const { clause, params } = whereTenant(tenantCtx);
  
  const now = Date.now();
  const result = db.query(`
    UPDATE governance_approvals
    SET status = 'expired', decision = 'expired', decided_at = ?
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ? ${clause}
  `).run(now, now, ...params);

  return result.changes;
}

function expireRequest(requestId: string, ctx?: TenantContext): void {
  const db = getDashboardDb();
  if (!db) return;

  const tenantCtx = ctx ?? getCurrentTenantContext();
  const { clause, params } = whereTenant(tenantCtx);
  
  const now = Date.now();
  db.query(`
    UPDATE governance_approvals
    SET status = 'expired', decision = 'expired', decided_at = ?
    WHERE id = ? AND status = 'pending' ${clause}
  `).run(now, requestId, ...params);
}