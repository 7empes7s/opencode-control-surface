import {
  createApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
  submitVote,
  expireStaleRequests,
} from "../governance/approvals.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

export async function approvalCreateHandler(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.workflowId || !body?.runId || !body?.requiredCount) {
    return Response.json({ error: "workflowId, runId, and requiredCount are required" }, { status: 400 });
  }
  const ctx = getCurrentTenantContext();
  const requestedBy: string = body.requestedBy ?? "operator";
  const requiredCount: number = Number(body.requiredCount) || 1;
  const expiresAt: number | undefined = body.expiresAt ? Number(body.expiresAt) : undefined;

  const request = createApprovalRequest(body.workflowId, body.runId, requestedBy, requiredCount, expiresAt, ctx);
  return Response.json({ request }, { status: 201 });
}

export async function approvalsListHandler(req: Request): Promise<Response> {
  const ctx = getCurrentTenantContext();
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const status = statusParam as "pending" | "approved" | "rejected" | "expired" | undefined;

  expireStaleRequests(ctx);

  const requests = listApprovalRequests(status, ctx);
  return Response.json({ requests });
}

export async function approvalGetHandler(req: Request, id: string): Promise<Response> {
  const ctx = getCurrentTenantContext();
  const request = getApprovalRequest(id, ctx);
  if (!request) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ request });
}

export async function approvalVoteHandler(req: Request, id: string): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.decision || !["approve", "reject"].includes(body.decision)) {
    return Response.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 });
  }

  const ctx = getCurrentTenantContext();
  const request = getApprovalRequest(id, ctx);
  if (!request) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (request.status !== "pending") {
    return Response.json({ error: `request is already ${request.status}` }, { status: 409 });
  }

  const voter = req.headers.get("x-operator-token") ?? "unknown";
  const comment: string | undefined = body.comment;

  const updated = submitVote(id, voter, body.decision, comment, ctx);
  return Response.json({ request: updated });
}

export async function approvalExpireHandler(req: Request, id: string): Promise<Response> {
  const roleErr = requireAdminRole(req);
  if (roleErr) return roleErr;

  const ctx = getCurrentTenantContext();
  const request = getApprovalRequest(id, ctx);
  if (!request) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  expireStaleRequests(ctx);
  const updated = getApprovalRequest(id, ctx);
  return Response.json({ request: updated });
}

function requireAdminRole(req: Request): Response | null {
  const token = req.headers.get("x-operator-token") ?? "";
  if (!token) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}