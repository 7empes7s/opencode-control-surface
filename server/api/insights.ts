import { createApprovalRequest, getApprovalRequest } from "../governance/approvals.ts";
import { checkPermission, getRoleForRequest } from "../governance/rbac.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { ok, type ActionDescriptor } from "./types.ts";
import { checkToken } from "./actions.ts";
import { getAuthenticatedUser } from "../auth/session.ts";
import { executeActionHandler } from "./execute.ts";
import { aggregateInsights } from "../insights/aggregate.ts";
import { runInsightsScanOnce } from "../insights/scheduler.ts";
import { getInsight, listInsights, updateInsightStatus } from "../insights/store.ts";
import type { Insight } from "../insights/types.ts";
import { dispatchEventFireAndForget } from "../webhooks/dispatcher.ts";

type ActionEnforcement = Pick<ActionDescriptor, "risk" | "confirm" | "reasonRequired">;

// Module-level throttle: aggregateInsights() scans the whole platform and takes
// 2-4s per run. The UI polls /api/insights every 30s, so we cap the list handler
// to one re-aggregation per LIST_AGGREGATE_THROTTLE_MS. The scheduler's full
// scans run independently and are unaffected.
const LIST_AGGREGATE_THROTTLE_MS = 60_000;
let lastAggregatedAt = 0;

export function _getLastAggregatedAt(): number {
  return lastAggregatedAt;
}

export function _resetAggregationThrottleForTests(): void {
  lastAggregatedAt = 0;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function plainError(message: string, status: number): Response {
  return json({ error: message }, status);
}

function getUserId(req: Request): string {
  return getAuthenticatedUser(req)?.userId ?? "anonymous";
}

export function requireInsightPermission(req: Request, action: "insights.view" | "insights.apply" | "insights.dismiss"): Response | null {
  if (!checkToken(req)) return plainError("unauthorized", 401);
  const role = getRoleForRequest(req);
  if (checkPermission(role, action)) return null;
  return plainError(`Your ${role} role can view insights but cannot make this change. Ask an owner or operator to apply it.`, 403);
}

function inferActionEnforcement(actionId: string): ActionEnforcement {
  const [kind, targetType] = actionId.split(":");
  if (kind === "start-job") {
    return {
      risk: targetType === "service" || targetType === "vast" ? "high" : "medium",
      confirm: true,
      reasonRequired: true,
    };
  }
  if (kind === "mutate-policy" && targetType === "budget") {
    return { risk: "medium", confirm: true, reasonRequired: true };
  }
  if (kind === "mutate-policy") return { risk: "high", confirm: true, reasonRequired: true };
  if (kind === "resolve" || kind === "mute") return { risk: "medium", confirm: true, reasonRequired: true };
  return { risk: "low", confirm: false, reasonRequired: false };
}

function safeBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function insightsListHandler(req: Request, url: URL): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.view");
  if (roleErr) return roleErr;

  const now = Date.now();
  if (now - lastAggregatedAt >= LIST_AGGREGATE_THROTTLE_MS) {
    lastAggregatedAt = now;
    aggregateInsights();
  }
  const status = url.searchParams.get("status") as "open" | "applied" | "dismissed" | "all" | null;
  const insights = listInsights(status ?? "open");
  const openCount = insights.filter((insight) => insight.status === "open").length;
  return json(ok({ insights, openCount }));
}

export async function insightsScanHandler(req: Request): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.apply");
  if (roleErr) return roleErr;

  const result = await runInsightsScanOnce();
  const insights = listInsights("open");
  writeActionAudit({
    actor: getUserId(req),
    actorSource: getCurrentTenantContext().source,
    actionKind: "insights.scan",
    targetType: "insights",
    targetId: "scan",
    risk: "low",
    request: {},
    resultStatus: "success",
    resultJson: result,
  });
  return json(ok({ ...result, insights }));
}

export async function insightApplyHandler(req: Request, id: string): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.apply");
  if (roleErr) return roleErr;

  const before = getInsight(id);
  if (!before) return plainError("That insight is no longer available.", 404);
  if (before.status !== "open") {
    return plainError(`This insight has already been ${before.status}.`, 409);
  }
  if (!before.actionDescriptorId) {
    return plainError("This insight does not have a one-click action yet. Open the manual page to configure it.", 400);
  }

  const body = safeBody(await req.json().catch(() => ({})));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const confirmed = body.confirmed === true;
  const enforcement = inferActionEnforcement(before.actionDescriptorId);
  const actor = getUserId(req);

  if (enforcement.confirm && !confirmed) {
    return plainError("Please confirm this action before applying the insight.", 400);
  }
  if (enforcement.reasonRequired && !reason) {
    return plainError("Please add a short reason before applying this insight.", 400);
  }

  if ((enforcement.risk === "high" || enforcement.risk === "destructive") && typeof body.approvalId !== "string") {
    const approval = createApprovalRequest("insights", before.id, actor, 1, Date.now() + 60 * 60_000);
    writeActionAudit({
      actor,
      actorSource: getCurrentTenantContext().source,
      actionKind: "insights.apply.approval-requested",
      actionId: before.actionDescriptorId,
      targetType: "insight",
      targetId: before.id,
      risk: enforcement.risk,
      reason,
      request: { insightId: before.id, approvalId: approval.id },
      resultStatus: "pending_approval",
      resultJson: { before, approvalId: approval.id },
      evidence: before.evidenceRefs,
    });
    return json(ok({
      insight: before,
      approval,
      message: "This action is high risk, so an approval request was opened before applying it.",
    }), 202);
  }

  if (typeof body.approvalId === "string") {
    const approval = getApprovalRequest(body.approvalId);
    if (!approval || approval.status !== "approved") {
      return plainError("This action is waiting for approval before it can be applied.", 409);
    }
  }

  const executeReq = new Request("http://localhost/api/actions/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-actor": actor,
      "x-operator-token": req.headers.get("x-operator-token") ?? "",
    },
    body: JSON.stringify({
      actionId: before.actionDescriptorId,
      reason,
      confirmed,
      params: body.params ?? {},
    }),
  });
  const executeRes = await executeActionHandler(executeReq);
  const executeBody = await executeRes.json().catch(() => ({ ok: false, error: "The action did not return a readable result." })) as Record<string, unknown>;
  if (!executeRes.ok || executeBody.ok === false) {
    const message = typeof executeBody.error === "string"
      ? executeBody.error
      : "The action could not be applied. Review the manual page and try again.";
    writeActionAudit({
      actor,
      actorSource: getCurrentTenantContext().source,
      actionKind: "insights.apply",
      actionId: before.actionDescriptorId,
      targetType: "insight",
      targetId: before.id,
      risk: enforcement.risk,
      reason,
      request: { insightId: before.id },
      resultStatus: "failed",
      resultJson: { before },
      evidence: before.evidenceRefs,
      error: message,
    });
    return plainError(message, executeRes.status || 500);
  }

  const after = updateInsightStatus(before.id, "applied") as Insight;
  writeActionAudit({
    actor,
    actorSource: getCurrentTenantContext().source,
    actionKind: "insights.apply",
    actionId: before.actionDescriptorId,
    targetType: "insight",
    targetId: before.id,
    risk: enforcement.risk,
    reason,
    request: { insightId: before.id, actionDescriptorId: before.actionDescriptorId },
    resultStatus: "success",
    result: "insight applied",
    resultJson: { before, after, actionResult: executeBody },
    evidence: before.evidenceRefs,
    rollbackHint: "Open the audit page to inspect the action result and use the linked manual page to reverse the configuration if needed.",
  });

  // Phase G: fire-and-forget webhook for applied actions
  try {
    dispatchEventFireAndForget("action.applied", {
      insightId: before.id,
      actionDescriptorId: before.actionDescriptorId,
      actor,
      severity: before.severity,
      domain: before.domain,
    });
  } catch { /* never throw out of apply path */ }

  return json(ok({ insight: after, actionResult: executeBody, message: "The insight was applied and recorded in the audit trail." }));
}

export async function insightDismissHandler(req: Request, id: string): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.dismiss");
  if (roleErr) return roleErr;

  const before = getInsight(id);
  if (!before) return plainError("That insight is no longer available.", 404);
  const body = safeBody(await req.json().catch(() => ({})));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return plainError("Please add a short reason before dismissing this insight.", 400);

  const after = updateInsightStatus(id, "dismissed");
  writeActionAudit({
    actor: getUserId(req),
    actorSource: getCurrentTenantContext().source,
    actionKind: "insights.dismiss",
    targetType: "insight",
    targetId: id,
    risk: "low",
    reason,
    request: { insightId: id },
    resultStatus: "success",
    result: "insight dismissed",
    resultJson: { before, after },
    evidence: before.evidenceRefs,
  });

  return json(ok({ insight: after, message: "The insight was dismissed and the reason was recorded." }));
}
