import { createApprovalRequest, getApprovalRequest } from "../governance/approvals.ts";
import { checkPermission, getRoleForRequest } from "../governance/rbac.ts";
import { readActionAudit, writeActionAudit } from "../db/writer.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { ok, type ActionDescriptor } from "./types.ts";
import { checkToken } from "./actions.ts";
import { getAuthenticatedUser } from "../auth/session.ts";
import { executeActionHandler } from "./execute.ts";
import { aggregateInsights } from "../insights/aggregate.ts";
import { runInsightsScanOnce } from "../insights/scheduler.ts";
import { acknowledgeInsights, getInsight, listInsights, snoozeInsights, updateInsightStatus } from "../insights/store.ts";
import { getAiAnalysis, enrichInsight } from "../insights/ai.ts";
import { previewAutoApplyCandidates, riskTierFor } from "../insights/autoapply.ts";
import { tierForAction } from "../insights/autoapplyPolicy.ts";
import type { Insight } from "../insights/types.ts";
import { dispatchEventFireAndForget } from "../webhooks/dispatcher.ts";
import { reasonerApplyPlaybookHandler } from "./reasoner.ts";

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
  if (tierForAction(actionId) === "auto") {
    return { risk: "low", confirm: false, reasonRequired: false };
  }
  if (actionId.startsWith("reasoner-remediate")) {
    return { risk: "medium", confirm: true, reasonRequired: true };
  }
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

function executableRollbackHint(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/^[a-z0-9-]+:[a-z0-9-]+(?::[^\s]+)*$/i.test(value)) return null;
  return value;
}

function rollbackHintForActionId(actionId: string | null | undefined): string | null {
  if (!actionId) return null;
  const parts = actionId.split(":");
  const [kind, targetType, targetId, suffix] = parts;
  if (kind === "mutate-policy" && targetType === "model") {
    if (suffix === "block") return `mutate-policy:model:${targetId}:unblock`;
    if (suffix === "unblock") return `mutate-policy:model:${targetId}:block`;
  }
  if (kind === "start-job" && targetType === "gateway" && targetId === "route-healthiest") {
    return "start-job:gateway:clear-route-override";
  }
  return null;
}

function latestRollbackHintForInsight(insightId: string): string | null {
  const rows = readActionAudit({ targetType: "insight", resultStatus: "success", limit: 200 });
  const row = rows
    .filter((entry) => entry.actionKind === "insights.apply" && entry.targetId === insightId)
    .sort((a, b) => b.ts - a.ts)[0];
  return executableRollbackHint(row?.rollbackHint);
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
  const withAi = insights.map((insight) => ({
    ...insight,
    aiAnalysis: getAiAnalysis(insight.id),
    riskTier: riskTierFor(insight),
    rollbackHint: insight.status === "applied" ? latestRollbackHintForInsight(insight.id) : null,
  }));
  return json(ok({ insights: withAi, openCount }));
}

export async function insightsReanalyzeHandler(req: Request, insightId: string): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.apply");
  if (roleErr) return roleErr;

  const insight = getInsight(insightId);
  if (!insight) return plainError("insight not found", 404);

  const analysis = await enrichInsight(insight, { force: true });
  writeActionAudit({
    actor: getUserId(req),
    actorSource: getCurrentTenantContext().source,
    actionKind: "insights.reanalyze",
    targetType: "insight",
    targetId: insightId,
    risk: "low",
    request: {},
    resultStatus: analysis ? "success" : "error",
    result: analysis ? `Re-analysed with ${analysis.model}` : "AI analysis unavailable",
  });
  if (!analysis) return plainError("AI analysis is currently unavailable. Try again shortly.", 503);
  return json(ok({ insight: { ...insight, aiAnalysis: analysis } }));
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

type ApplyOutcome =
  | { status: "applied"; insight: Insight; result: Record<string, unknown>; message: string }
  | { status: "approval"; insight: Insight; approval: unknown; message: string }
  | { status: "error"; httpStatus: number; message: string };

async function applyInsightCore(
  id: string,
  opts: { reason: string; confirmed: boolean; approvalId?: string },
  actor: string,
  operatorToken: string,
): Promise<ApplyOutcome> {
  const before = getInsight(id);
  if (!before) return { status: "error", httpStatus: 404, message: "That insight is no longer available." };
  if (before.status !== "open") {
    return { status: "error", httpStatus: 409, message: `This insight has already been ${before.status}.` };
  }
  if (!before.actionDescriptorId) {
    return { status: "error", httpStatus: 400, message: "This insight does not have a one-click action yet. Open the manual page to configure it." };
  }
  if (tierForAction(before.actionDescriptorId) === "off") {
    return { status: "error", httpStatus: 400, message: "Auto-apply policy is off for this action. Change the policy before applying it." };
  }

  const enforcement = inferActionEnforcement(before.actionDescriptorId);

  if (enforcement.confirm && !opts.confirmed) {
    return { status: "error", httpStatus: 400, message: "Please confirm this action before applying the insight." };
  }
  if (enforcement.reasonRequired && !opts.reason) {
    return { status: "error", httpStatus: 400, message: "Please add a short reason before applying this insight." };
  }

  if ((enforcement.risk === "high" || enforcement.risk === "destructive") && !opts.approvalId) {
    const approval = createApprovalRequest("insights", before.id, actor, 1, Date.now() + 60 * 60_000);
    writeActionAudit({
      actor,
      actorSource: getCurrentTenantContext().source,
      actionKind: "insights.apply.approval-requested",
      actionId: before.actionDescriptorId,
      targetType: "insight",
      targetId: before.id,
      risk: enforcement.risk,
      reason: opts.reason,
      request: { insightId: before.id, approvalId: approval.id },
      resultStatus: "pending_approval",
      resultJson: { before, approvalId: approval.id },
      evidence: before.evidenceRefs,
    });
    return { status: "approval", insight: before, approval, message: "This action is high risk, so an approval request was opened before applying it." };
  }

  if (opts.approvalId) {
    const approval = getApprovalRequest(opts.approvalId);
    if (!approval || approval.status !== "approved") {
      return { status: "error", httpStatus: 409, message: "This action is waiting for approval before it can be applied." };
    }
  }

  let execOk: boolean;
  let execBody: Record<string, unknown>;
  let execStatus: number;

  if (before.actionDescriptorId.startsWith("reasoner-remediate:")) {
    const p = before.actionDescriptorId.split(":");
    const body = JSON.stringify({
      workflowId: p[2],
      passId: p[3] || undefined,
      incidentId: p[4] || undefined,
    });
    const remReq = new Request("http://localhost/api/reasoner/playbooks/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor": actor,
        "x-operator-token": operatorToken,
      },
      body,
    });
    try {
      const remRes = await reasonerApplyPlaybookHandler(p[1], remReq);
      execBody = await remRes.json().catch(() => ({ ok: false, error: "remediation returned no readable result" }));
      execStatus = remRes.status;
      execOk = remRes.ok && execBody.ok !== false;
    } catch (err) {
      execBody = { ok: false, error: err instanceof Error ? err.message : "remediation failed" };
      execStatus = 500;
      execOk = false;
    }
  } else {
    const executeReq = new Request("http://localhost/api/actions/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-actor": actor,
        "x-operator-token": operatorToken,
      },
      body: JSON.stringify({
        actionId: before.actionDescriptorId,
        reason: opts.reason,
        confirmed: opts.confirmed,
        params: {},
      }),
    });
    const executeRes = await executeActionHandler(executeReq);
    execBody = await executeRes.json().catch(() => ({ ok: false, error: "The action did not return a readable result." })) as Record<string, unknown>;
    execStatus = executeRes.status;
    execOk = executeRes.ok && execBody.ok !== false;
  }

  if (!execOk) {
    const message = typeof execBody.error === "string"
      ? execBody.error
      : "The action could not be applied. Review the manual page and try again.";
    writeActionAudit({
      actor,
      actorSource: getCurrentTenantContext().source,
      actionKind: "insights.apply",
      actionId: before.actionDescriptorId,
      targetType: "insight",
      targetId: before.id,
      risk: enforcement.risk,
      reason: opts.reason,
      request: { insightId: before.id },
      resultStatus: "failed",
      resultJson: { before },
      evidence: before.evidenceRefs,
      error: message,
    });
    return { status: "error", httpStatus: execStatus || 500, message };
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
    reason: opts.reason,
    request: { insightId: before.id, actionDescriptorId: before.actionDescriptorId },
    resultStatus: "success",
    result: "insight applied",
    resultJson: { before, after, actionResult: execBody },
    evidence: before.evidenceRefs,
    rollbackHint: rollbackHintForActionId(before.actionDescriptorId),
  });

  try {
    dispatchEventFireAndForget("action.applied", {
      insightId: before.id,
      actionDescriptorId: before.actionDescriptorId,
      actor,
      severity: before.severity,
      domain: before.domain,
    });
  } catch { /* never throw out of apply path */ }

  return { status: "applied", insight: after, result: execBody, message: "The insight was applied and recorded in the audit trail." };
}

export async function insightsAutoApplyPreviewHandler(req: Request): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.view");
  if (roleErr) return roleErr;

  const candidates = previewAutoApplyCandidates(listInsights("open"), 25);
  return json(ok({ candidates }));
}

export async function insightApplyHandler(req: Request, id: string): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.apply");
  if (roleErr) return roleErr;

  const body = safeBody(await req.json().catch(() => ({})));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const confirmed = body.confirmed === true;
  const approvalId = typeof body.approvalId === "string" ? body.approvalId : undefined;
  const actor = getUserId(req);
  const operatorToken = req.headers.get("x-operator-token") ?? "";

  const outcome = await applyInsightCore(id, { reason, confirmed, approvalId }, actor, operatorToken);

  if (outcome.status === "applied") {
    return json(ok({ insight: outcome.insight, actionResult: outcome.result, message: outcome.message }));
  }
  if (outcome.status === "approval") {
    return json(ok({ insight: outcome.insight, approval: outcome.approval, message: outcome.message }), 202);
  }
  return plainError(outcome.message, outcome.httpStatus);
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

export async function insightsBulkApplyHandler(req: Request): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.apply");
  if (roleErr) return roleErr;

  const body = safeBody(await req.json().catch(() => ({})));
  const domain = typeof body.domain === "string" ? body.domain : undefined;
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : undefined;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const confirmed = body.confirmed === true;
  const mode = body.mode === "reviewSelected" ? "reviewSelected" : "autoOnly";

  const allOpen = listInsights("open");
  const requested = allOpen.filter((insight) => {
    if (ids && !ids.includes(insight.id)) return false;
    if (domain && insight.domain !== domain) return false;
    return true;
  });
  const candidates = allOpen.filter((insight) => {
    if (!insight.actionDescriptorId) return false;
    const tier = tierForAction(insight.actionDescriptorId);
    if (tier === "off") return false;
    if (mode === "autoOnly" && tier !== "auto") return false;
    if (ids && !ids.includes(insight.id)) return false;
    if (domain && insight.domain !== domain) return false;
    return true;
  });

  const actor = getUserId(req);
  const operatorToken = req.headers.get("x-operator-token") ?? "";

  const applied: Array<{ id: string; title: string }> = [];
  const skipped: Array<{ id: string; title: string; reason: string }> = [];
  const failed: Array<{ id: string; title: string; reason: string }> = [];

  for (const insight of requested) {
    if (!insight.actionDescriptorId) {
      skipped.push({ id: insight.id, title: insight.title, reason: "No one-click action is available." });
      continue;
    }
    const tier = tierForAction(insight.actionDescriptorId);
    if (tier === "off") {
      skipped.push({ id: insight.id, title: insight.title, reason: "Auto-apply policy is off for this action." });
      continue;
    }
    if (mode === "autoOnly" && tier !== "auto") {
      skipped.push({ id: insight.id, title: insight.title, reason: "Skipped review-tier action in apply-safe mode." });
    }
  }

  for (const insight of candidates) {
    try {
      const outcome = await applyInsightCore(insight.id, { reason, confirmed: confirmed || mode === "autoOnly" }, actor, operatorToken);
      if (outcome.status === "applied") {
        applied.push({ id: insight.id, title: insight.title });
      } else if (outcome.status === "approval") {
        skipped.push({ id: insight.id, title: insight.title, reason: outcome.message });
      } else {
        failed.push({ id: insight.id, title: insight.title, reason: outcome.message });
      }
    } catch (err) {
      failed.push({
        id: insight.id,
        title: insight.title,
        reason: err instanceof Error ? err.message : "Unexpected error while applying.",
      });
    }
  }

  const message = `Applied ${applied.length} safe finding${applied.length === 1 ? "" : "s"}. ${skipped.length} skipped, ${failed.length} failed.`;
  return json(ok({
    applied: applied.length,
    appliedIds: applied.map((a) => a.id),
    skipped,
    failed,
    message,
  }));
}

export async function insightsBulkAcknowledgeHandler(req: Request): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.dismiss");
  if (roleErr) return roleErr;

  const body = safeBody(await req.json().catch(() => ({})));
  const ids = Array.isArray(body.ids) ? Array.from(new Set(body.ids.filter((v): v is string => typeof v === "string"))) : [];
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (ids.length === 0) return plainError("ids are required", 400);

  const openIds = new Set(listInsights("open").map((insight) => insight.id));
  const targetIds = ids.filter((id) => openIds.has(id));
  const acknowledged = acknowledgeInsights(targetIds, { actor: getUserId(req), reason });

  writeActionAudit({
    actor: getUserId(req),
    actorSource: getCurrentTenantContext().source,
    actionKind: "insights.bulk-ack",
    targetType: "insights",
    targetId: "bulk",
    risk: "low",
    reason,
    request: { ids: targetIds },
    resultStatus: "success",
    result: `acknowledged ${acknowledged.length} insight(s)`,
    resultJson: { acknowledgedIds: acknowledged.map((insight) => insight.id) },
  });

  return json(ok({
    acknowledged: acknowledged.length,
    acknowledgedIds: acknowledged.map((insight) => insight.id),
    skippedIds: ids.filter((id) => !openIds.has(id)),
    message: `Acknowledged ${acknowledged.length} finding${acknowledged.length === 1 ? "" : "s"}.`,
  }));
}

export async function insightsBulkSnoozeHandler(req: Request): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.dismiss");
  if (roleErr) return roleErr;

  const body = safeBody(await req.json().catch(() => ({})));
  const ids = Array.isArray(body.ids) ? Array.from(new Set(body.ids.filter((v): v is string => typeof v === "string"))) : [];
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const until = typeof body.until === "number" && Number.isFinite(body.until)
    ? body.until
    : Date.now() + 24 * 60 * 60_000;
  if (ids.length === 0) return plainError("ids are required", 400);
  if (until <= Date.now()) return plainError("until must be in the future", 400);

  const openIds = new Set(listInsights("open").map((insight) => insight.id));
  const targetIds = ids.filter((id) => openIds.has(id));
  const snoozed = snoozeInsights(targetIds, until, { actor: getUserId(req), reason });

  writeActionAudit({
    actor: getUserId(req),
    actorSource: getCurrentTenantContext().source,
    actionKind: "insights.bulk-snooze",
    targetType: "insights",
    targetId: "bulk",
    risk: "low",
    reason,
    request: { ids: targetIds, until },
    resultStatus: "success",
    result: `snoozed ${snoozed.length} insight(s)`,
    resultJson: { snoozedIds: snoozed.map((insight) => insight.id), until },
  });

  return json(ok({
    snoozed: snoozed.length,
    snoozedIds: snoozed.map((insight) => insight.id),
    skippedIds: ids.filter((id) => !openIds.has(id)),
    until,
    message: `Snoozed ${snoozed.length} finding${snoozed.length === 1 ? "" : "s"} until ${new Date(until).toLocaleString()}.`,
  }));
}
