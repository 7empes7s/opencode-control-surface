import { execSync } from "node:child_process";
import { writeActionAudit } from "../db/writer.ts";
import { ALLOWED_SERVICES, ALLOWED_CONTAINERS, ALLOWED_TIMERS } from "./actions.ts";
import { selectHealthiestGatewayModel } from "./gateway.ts";
import { setGatewayRouteOverrideForGatewayAdmin } from "../gateway/router.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { modelQualityPath, setModelQualityStatus } from "./modelQuality.ts";

const PIPELINE_API = "http://127.0.0.1:3200";

interface ExecuteRequest {
  actionId: string;
  reason?: string;
  confirmed?: boolean;
  params?: Record<string, unknown>;
}

type ExecuteResult =
  | { ok: true; action: string; jobId?: string; text?: string; url?: string; path?: string; route?: string; message?: string; result?: Record<string, unknown> }
  | { ok: false; error: string; code: "BAD_REQUEST" | "NOT_FOUND" | "DISABLED" | "CONFIRM_REQUIRED" | "REASON_REQUIRED" | "ALLOWLIST" | "NOT_IMPLEMENTED" | "EXEC_ERROR" }

interface ParsedActionId {
  kind: string;
  targetType: string;
  targetId: string;
  suffix?: string;
}

function parseActionId(actionId: string): ParsedActionId | null {
  if (!actionId || actionId.trim() === "") {
    return null;
  }
  const segments = actionId.split(":");
  if (segments.length < 2) {
    return null;
  }
  return {
    kind: segments[0],
    targetType: segments[1],
    targetId: segments[2] ?? "",
    suffix: segments[3],
  };
}

function getEnforcement(kind: string, targetType: string): { confirm: boolean; reasonRequired: boolean } {
  if (kind === "navigate" || kind === "copy-command" || kind === "external-link" || kind === "open-source" || kind === "preview" || kind === "refresh") {
    return { confirm: false, reasonRequired: false };
  }
  if (kind === "start-job") {
    return { confirm: true, reasonRequired: true };
  }
  if (kind === "mutate-policy") return { confirm: true, reasonRequired: true };
  if (kind === "acknowledge") return { confirm: false, reasonRequired: false };
  if (kind === "resolve") return { confirm: true, reasonRequired: true };
  if (kind === "mute") return { confirm: true, reasonRequired: true };
  return { confirm: false, reasonRequired: false };
}

function getRisk(kind: string, targetType: string, suffix?: string): "low" | "medium" | "high" {
  if (kind === "start-job" && (targetType === "service" || targetType === "vast")) return "high";
  if (kind === "start-job") return "medium";
  if (kind === "mutate-policy") {
    if (targetType === "budget") return "medium";
    return "high";
  }
  return "low";
}

async function routeAndExecute(
  parsed: ParsedActionId,
  body: ExecuteRequest,
  _req: Request,
): Promise<ExecuteResult> {
  const { kind, targetType, targetId, suffix } = parsed;

  if (kind === "navigate") {
    return { ok: true, action: "navigate", route: "/" + targetType };
  }

  if (kind === "copy-command") {
    let text = "";
    if (targetType === "service") {
      if (ALLOWED_CONTAINERS.includes(targetId)) {
        text = `docker inspect --format='{{.State.Status}}' ${targetId}`;
      } else if (ALLOWED_SERVICES.includes(targetId)) {
        text = `systemctl is-active ${targetId}`;
      }
    } else if (targetType === "gpu") {
      text = "curl -s http://127.0.0.1:11434/api/tags";
    }
    return { ok: true, action: "copy-command", text };
  }

  if (kind === "external-link" && targetType === "article") {
    return { ok: true, action: "external-link", url: "https://news.techinsiderbytes.com/articles/" + targetId };
  }

  if (kind === "open-source" && targetType === "article") {
    return { ok: true, action: "open-source", path: "/opt/newsbites/content/articles/" + targetId + ".md" };
  }

  if (kind === "start-job" && targetType === "service") {
    if (!ALLOWED_SERVICES.includes(targetId) && !ALLOWED_CONTAINERS.includes(targetId)) {
      return { ok: false, error: "not in allowlist", code: "ALLOWLIST" };
    }
    try {
      if (ALLOWED_CONTAINERS.includes(targetId)) {
        execSync("docker restart " + targetId, { timeout: 60_000 });
      } else {
        execSync("systemctl restart " + targetId, { timeout: 30_000 });
      }
      return { ok: true, action: "start-job", message: targetId + " restarted" };
    } catch {
      return { ok: false, error: "execution failed", code: "EXEC_ERROR" };
    }
  }

  if (kind === "start-job" && targetType === "vast") {
    if (!ALLOWED_SERVICES.includes(targetId) && !ALLOWED_CONTAINERS.includes(targetId)) {
      return { ok: false, error: "not in allowlist", code: "ALLOWLIST" };
    }
    try {
      execSync("systemctl restart " + targetId, { timeout: 30_000 });
      return { ok: true, action: "start-job", message: targetId + " restarted" };
    } catch {
      return { ok: false, error: "execution failed", code: "EXEC_ERROR" };
    }
  }

  if (kind === "start-job" && targetType === "timer") {
    if (!ALLOWED_TIMERS.includes(targetId)) {
      return { ok: false, error: "not in allowlist", code: "ALLOWLIST" };
    }
    try {
      execSync("systemctl start " + targetId + ".service", { timeout: 5_000 });
      return { ok: true, action: "start-job", message: targetId + " started" };
    } catch {
      return { ok: false, error: "execution failed", code: "EXEC_ERROR" };
    }
  }

if (kind === "start-job" && targetType === "doctor" && targetId === "scan") {
    try {
      const res = await fetch(PIPELINE_API + "/doctor/scan", { method: "POST", signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        return { ok: true, action: "start-job", message: "doctor scan started" };
      }
      return { ok: false, error: "doctor scan failed", code: "EXEC_ERROR" as const };
    } catch {
      return { ok: false, error: "execution failed", code: "EXEC_ERROR" as const };
    }
  }

  if (kind === "start-job" && targetType === "model-health" && targetId === "all") {
    try {
      execSync("systemctl start model-health-check.service", { timeout: 5_000 });
      return { ok: true, action: "start-job", message: "model health check started" };
    } catch {
      return { ok: false, error: "execution failed", code: "EXEC_ERROR" };
    }
  }

  if (kind === "start-job" && targetType === "gateway" && targetId === "route-healthiest") {
    const selected = selectHealthiestGatewayModel();
    if (!selected) {
      return { ok: false, error: "no gateway models available", code: "NOT_FOUND" };
    }
    const ctx = getCurrentTenantContext();
    const ttlMs = typeof body.params?.ttlMs === "number" && Number.isFinite(body.params.ttlMs)
      ? body.params.ttlMs
      : 15 * 60_000;
    const routeOverride = setGatewayRouteOverrideForGatewayAdmin({
      targetModel: selected.logicalName,
      resolvedModel: selected.resolvedModel,
      tier: selected.tier,
      reason: body.reason,
      setBy: ctx.actor ?? "operator",
      ttlMs,
    });
    return {
      ok: true,
      action: "start-job",
      message: `Routing gateway traffic to ${selected.logicalName} until ${routeOverride.expiresAt}.`,
    };
  }

  if (kind === "mutate-policy" && targetType === "model") {
    if (!suffix || !["block", "unblock", "probation-clear"].includes(suffix)) {
      return { ok: false, error: "invalid mutate-policy suffix", code: "BAD_REQUEST" };
    }
    try {
      setModelQualityStatus(targetId, suffix === "block" ? "blocked" : "healthy", modelQualityPath());
      return { ok: true, action: "mutate-policy", message: targetId + " → " + suffix };
    } catch {
      return { ok: false, error: "execution failed", code: "EXEC_ERROR" };
    }
  }

  if (kind === "mutate-policy" && targetType === "budget" && targetId === "global" && suffix === "set-cap") {
    const dailyCapUsd = typeof body.params?.dailyCapUsd === "number" ? body.params.dailyCapUsd : 5;
    const monthlyCapUsd = typeof body.params?.monthlyCapUsd === "number" ? body.params.monthlyCapUsd : 50;
    if (!Number.isFinite(dailyCapUsd) || dailyCapUsd <= 0 || dailyCapUsd > 10000) {
      return { ok: false, error: "dailyCapUsd must be a number between 1 and 10000", code: "BAD_REQUEST" };
    }
    if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0 || monthlyCapUsd > 10000) {
      return { ok: false, error: "monthlyCapUsd must be a number between 1 and 10000", code: "BAD_REQUEST" };
    }
    try {
      const { upsertBudget } = await import("../governance/budgets.ts");
      const budget = upsertBudget("global", { dailyCapUsd, monthlyCapUsd, warnPct: 0.8 });
      return {
        ok: true,
        action: "mutate-policy",
        result: { budget },
        message: `Global budget cap set: $${dailyCapUsd}/day, $${monthlyCapUsd}/month. Gateway calls are now governed by this cap.`,
      };
    } catch {
      return { ok: false, error: "execution failed", code: "EXEC_ERROR" };
    }
  }

  if (kind === "acknowledge" && targetType === "incident") {
    return { ok: false, error: "incident lifecycle not yet implemented", code: "NOT_IMPLEMENTED" };
  }

  if ((kind === "resolve" || kind === "mute") && targetType === "incident") {
    return { ok: false, error: "incident lifecycle not yet implemented", code: "NOT_IMPLEMENTED" };
  }

  return { ok: false, error: "action not supported: " + kind, code: "NOT_FOUND" };
}

export async function executeActionHandler(req: Request): Promise<Response> {
  let body: ExecuteRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json", code: "BAD_REQUEST" as const }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { actionId, reason, confirmed, params } = body;

  const parsed = parseActionId(actionId);
  if (!parsed) {
    writeActionAudit({
      actionKind: "unknown",
      actionId,
      targetType: "unknown",
      targetId: "unknown",
      risk: "low",
      reason,
      request: { actionId, confirmed, params },
      resultStatus: "failed",
      error: "invalid actionId format",
    });
    return new Response(JSON.stringify({ ok: false, error: "actionId required and must have at least 2 segments", code: "BAD_REQUEST" as const }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { kind, targetType, targetId, suffix } = parsed;
  const enforcement = getEnforcement(kind, targetType);

  if (enforcement.confirm && confirmed !== true) {
    writeActionAudit({
      actionKind: kind + "." + targetType,
      actionId,
      targetType,
      targetId,
      risk: getRisk(kind, targetType, suffix),
      reason,
      request: { actionId, confirmed, params },
      resultStatus: "failed",
      error: "confirmation required",
    });
    return new Response(JSON.stringify({ ok: false, error: "confirmation required", code: "CONFIRM_REQUIRED" as const }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (enforcement.reasonRequired && (!reason || reason.trim() === "")) {
    writeActionAudit({
      actionKind: kind + "." + targetType,
      actionId,
      targetType,
      targetId,
      risk: getRisk(kind, targetType, suffix),
      reason,
      request: { actionId, confirmed, params },
      resultStatus: "failed",
      error: "reason required",
    });
    return new Response(JSON.stringify({ ok: false, error: "reason required", code: "REASON_REQUIRED" as const }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await routeAndExecute(parsed, body, req);

  writeActionAudit({
    actionKind: kind + "." + targetType,
    actionId,
    targetType,
    targetId,
    risk: getRisk(kind, targetType, suffix),
    reason,
    request: { actionId, confirmed, params },
    resultStatus: result.ok ? "success" : "failed",
    result: result.ok ? (result as { message?: string }).message : undefined,
    error: result.ok ? undefined : (result as { error: string }).error,
  });

  if (!result.ok) {
    const errorResult = result as { ok: false; error: string; code: string };
    if (errorResult.code === "NOT_FOUND") {
      return new Response(JSON.stringify(result), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (errorResult.code === "NOT_IMPLEMENTED") {
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (errorResult.code === "ALLOWLIST") {
      return new Response(JSON.stringify(result), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (errorResult.code === "EXEC_ERROR") {
      return new Response(JSON.stringify(result), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (errorResult.code === "BAD_REQUEST") {
      return new Response(JSON.stringify(result), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
