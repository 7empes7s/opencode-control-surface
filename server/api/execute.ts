import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeActionAudit } from "../db/writer.ts";
import { ALLOWED_SERVICES, ALLOWED_CONTAINERS, ALLOWED_TIMERS } from "./actions.ts";
import { selectHealthiestGatewayModel } from "./gateway.ts";
import { clearGatewayRouteOverrideForGatewayAdmin, setGatewayRouteOverrideForGatewayAdmin } from "../gateway/router.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { clearModelCooldown, modelQualityPath, setModelQualityStatus } from "./modelQuality.ts";
import { isKnownPolicyRegistryKey } from "./policyRegistry.ts";
import { setAutoApplyTier, type AutoApplyTier } from "../insights/autoapplyPolicy.ts";

const PIPELINE_API = "http://127.0.0.1:3200";
const ESCALATION_PLAN_DIR = "/var/lib/control-surface/incident-escalation-plans";
const CONTROL_SURFACE_ROOT = "/opt/opencode-control-surface";

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
  segments: string[];
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
    segments,
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
  if (kind === "mitigate") return { confirm: true, reasonRequired: true };
  if (kind === "resolve") return { confirm: true, reasonRequired: true };
  if (kind === "mute") return { confirm: true, reasonRequired: true };
  if (kind === "unmute") return { confirm: false, reasonRequired: false };
  if (kind === "escalate") return { confirm: false, reasonRequired: false };
  return { confirm: false, reasonRequired: false };
}

function getRisk(kind: string, targetType: string, suffix?: string): "low" | "medium" | "high" {
  if (kind === "start-job" && (targetType === "service" || targetType === "vast")) return "high";
  if (kind === "start-job") return "medium";
  if (kind === "mutate-policy") {
    if (targetType === "autoapply") return "medium";
    if (targetType === "budget") return "medium";
    return "high";
  }
  if (kind === "escalate") return "medium";
  return "low";
}

function rollbackHintForActionId(actionId: string): string | undefined {
  const parsed = parseActionId(actionId);
  if (!parsed) return undefined;
  const { kind, targetType, targetId, suffix } = parsed;
  if (kind === "mutate-policy" && targetType === "model") {
    if (suffix === "block") return `mutate-policy:model:${targetId}:unblock`;
    if (suffix === "unblock") return `mutate-policy:model:${targetId}:block`;
  }
  if (kind === "start-job" && targetType === "gateway" && targetId === "route-healthiest") {
    return "start-job:gateway:clear-route-override";
  }
  if (kind === "mute" && targetType === "incident") return `unmute:incident:${targetId}`;
  if (kind === "unmute" && targetType === "incident") return `mute:incident:${targetId}`;
  return undefined;
}

type EscalationIncidentRow = {
  id: string;
  failure_class: string;
  title: string;
  first_seen: number;
  last_seen: number;
  occurrence_count: number;
  representative_pass_id: string;
  status: string;
  escalated_workflow_id: string | null;
  root_cause: string | null;
  evidence_json: string | null;
  suggested_actions_json: string | null;
};

function safeEscalationId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function escalationSuggestedActions(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return String(record.title ?? record.action ?? record.description ?? JSON.stringify(record));
      }
      return String(item);
    }).filter((item) => item.trim().length > 0);
  } catch {
    return [];
  }
}

function buildEscalationPlan(incident: EscalationIncidentRow, recurrence: { n: number; open_count: number | null }): string {
  const suggested = escalationSuggestedActions(incident.suggested_actions_json);
  const lines = [
    `# Escalated Incident — ${incident.title}`,
    "",
    `Source incident: ${incident.id}`,
    `Failure class: ${incident.failure_class}`,
    `Status: ${incident.status}`,
    `Occurrences: ${incident.occurrence_count} (first seen ${new Date(incident.first_seen).toISOString()}, last seen ${new Date(incident.last_seen).toISOString()})`,
    `Recurrence: ${recurrence.n} incident${recurrence.n === 1 ? "" : "s"} for this condition in the trailing 7 days${(recurrence.open_count ?? 0) > 0 ? ` (${recurrence.open_count} still open)` : ""}`,
    "",
    "## Goal",
    "",
    "Own the fix for this incident instead of relying on auto-remediation: reproduce the failure, address the root cause, and verify it no longer recurs.",
    "",
    "## Root-cause hypothesis",
    "",
    incident.root_cause?.trim() || "No representative diagnosis has been recorded yet. Start from the evidence links below.",
    "",
    "## Evidence",
    "",
  ];
  if (incident.evidence_json?.trim()) {
    lines.push("```json", incident.evidence_json.trim().slice(0, 4_000), "```");
  } else {
    lines.push("No representative diagnosis evidence was recorded.");
  }
  lines.push("", "## Suggested actions", "");
  if (suggested.length > 0) {
    for (const action of suggested.slice(0, 10)) lines.push(`- ${action}`);
  } else {
    lines.push("- No suggested actions were recorded; investigate from the evidence above.");
  }
  lines.push(
    "",
    "## Links",
    "",
    "- Incident drawer: /incidents",
    `- Incident API: /api/reasoner/incidents/${incident.id}`,
    `- Pass evidence: /api/builder/passes/${incident.representative_pass_id}/diagnosis`,
    "",
  );
  return lines.join("\n");
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
      // --no-block: these are oneshot jobs that can run for minutes; we only
      // need to enqueue them, not wait for completion (which would always
      // exceed the timeout and report a false failure).
      execSync("systemctl start --no-block " + targetId + ".service", { timeout: 5_000 });
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
      // --no-block: model-health-check is a oneshot that probes every model and
      // runs for minutes; enqueue it rather than waiting for it to finish.
      execSync("systemctl start --no-block model-health-check.service", { timeout: 5_000 });
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

  if (kind === "start-job" && targetType === "gateway" && targetId === "clear-route-override") {
    clearGatewayRouteOverrideForGatewayAdmin();
    return {
      ok: true,
      action: "start-job",
      message: "Gateway route override cleared.",
    };
  }

  if (kind === "mutate-policy" && targetType === "model") {
    if (!suffix || !["block", "unblock", "probation-clear", "cooldown-clear"].includes(suffix)) {
      return { ok: false, error: "invalid mutate-policy suffix", code: "BAD_REQUEST" };
    }
    try {
      if (suffix === "cooldown-clear") {
        const cooldownsPath = process.env.DASHBOARD_MODEL_COOLDOWNS_PATH || "/var/lib/mimule/model-cooldowns.json";
        clearModelCooldown(targetId, cooldownsPath);
      } else {
        setModelQualityStatus(targetId, suffix === "block" ? "blocked" : "healthy", modelQualityPath());
      }
      return { ok: true, action: "mutate-policy", message: targetId + " → " + suffix };
    } catch {
      return { ok: false, error: "execution failed", code: "EXEC_ERROR" };
    }
  }

  if (kind === "mutate-policy" && targetType === "autoapply") {
    const last = parsed.segments[parsed.segments.length - 1];
    if (last !== "set-tier" || parsed.segments.length < 5) {
      return { ok: false, error: "invalid autoapply policy action", code: "BAD_REQUEST" };
    }
    const key = parsed.segments.slice(2, -1).join(":");
    const tier = body.params?.tier;
    if (tier !== "auto" && tier !== "review" && tier !== "off") {
      return { ok: false, error: "tier must be auto, review, or off", code: "BAD_REQUEST" };
    }
    if (!await isKnownPolicyRegistryKey(key)) {
      return { ok: false, error: "unknown autoapply policy key", code: "BAD_REQUEST" };
    }
    const actor = getCurrentTenantContext().actor ?? "operator";
    const policy = setAutoApplyTier(key, tier as AutoApplyTier, actor);
    return {
      ok: true,
      action: "mutate-policy",
      message: `Auto-apply policy set ${key} to ${tier}.`,
      result: { key, tier, policy },
    };
  }

  if (
    kind === "mutate-policy" &&
    targetType === "budget" &&
    ((targetId === "global" && suffix === "set-cap") || (targetId === "project" && parsed.segments[4] === "set-cap"))
  ) {
    const scope = targetId === "project" ? "project" : "global";
    const projectId = scope === "project" ? decodeURIComponent(parsed.segments[3] ?? "") : null;
    const dailyCapUsd = typeof body.params?.dailyCapUsd === "number" ? body.params.dailyCapUsd : 5;
    const monthlyCapUsd = typeof body.params?.monthlyCapUsd === "number" ? body.params.monthlyCapUsd : 50;
    const warnPct = typeof body.params?.warnPct === "number" ? body.params.warnPct : 0.8;
    if (scope === "project" && (!projectId || projectId.length > 200)) {
      return { ok: false, error: "projectId is required for project budgets", code: "BAD_REQUEST" };
    }
    if (!Number.isFinite(dailyCapUsd) || dailyCapUsd <= 0 || dailyCapUsd > 10000) {
      return { ok: false, error: "dailyCapUsd must be a number between 1 and 10000", code: "BAD_REQUEST" };
    }
    if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0 || monthlyCapUsd > 10000) {
      return { ok: false, error: "monthlyCapUsd must be a number between 1 and 10000", code: "BAD_REQUEST" };
    }
    if (!Number.isFinite(warnPct) || warnPct < 0.1 || warnPct > 1) {
      return { ok: false, error: "warnPct must be between 0.1 and 1", code: "BAD_REQUEST" };
    }
    try {
      const { upsertBudget } = await import("../governance/budgets.ts");
      const budget = upsertBudget(scope, { projectId, dailyCapUsd, monthlyCapUsd, warnPct });
      return {
        ok: true,
        action: "mutate-policy",
        result: { budget },
        message: scope === "project"
          ? `Project budget cap set for ${projectId}: $${dailyCapUsd}/day, $${monthlyCapUsd}/month.`
          : `Global budget cap set: $${dailyCapUsd}/day, $${monthlyCapUsd}/month. Gateway calls are now governed by this cap.`,
      };
    } catch {
      return { ok: false, error: "execution failed", code: "EXEC_ERROR" };
    }
  }

  if (kind === "start-job" && targetType === "infra") {
    if (targetId === "vast-reconcile") {
      try {
        execSync("/usr/local/sbin/vast-reconcile.sh", { timeout: 60_000 });
        return { ok: true, action: "start-job", message: "vast-reconcile completed" };
      } catch {
        return { ok: false, error: "vast-reconcile failed", code: "EXEC_ERROR" };
      }
    }
    if (targetId === "doctor-log-rotate") {
      try {
        const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
        const src = "/var/lib/mimule/doctor-log.jsonl";
        const dst = `/var/lib/mimule/doctor-log.${ts}.jsonl.gz`;
        execSync(`/bin/sh -c 'gzip -c "${src}" > "${dst}" && truncate -s 0 "${src}"'`, { timeout: 30_000 });
        return { ok: true, action: "start-job", message: `doctor log rotated → ${dst}` };
      } catch {
        return { ok: false, error: "doctor-log rotation failed", code: "EXEC_ERROR" };
      }
    }
    if (targetId === "litellm-reload") {
      try {
        execSync("systemctl restart litellm", { timeout: 30_000 });
        return { ok: true, action: "start-job", message: "litellm restarted with new config" };
      } catch {
        return { ok: false, error: "litellm reload failed", code: "EXEC_ERROR" };
      }
    }
    return { ok: false, error: "unknown infra action: " + targetId, code: "NOT_FOUND" };
  }

  if (kind === "acknowledge" && targetType === "incident") {
    const { getDashboardDb, isDashboardDbEnabled } = await import("../db/dashboard.ts");
    if (!isDashboardDbEnabled()) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    const db = getDashboardDb();
    if (!db) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    try {
      const now = Date.now();
      const ctx = getCurrentTenantContext();
      const actor = ctx.actor ?? "operator";
      const existing = db.query(`
        SELECT id FROM reasoner_incidents
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).get(targetId, ctx.tenantId) as { id: string } | null;
      if (!existing) return { ok: false, error: "incident not found", code: "NOT_FOUND" };
      db.query(`
        UPDATE reasoner_incidents
        SET acknowledged_at = COALESCE(acknowledged_at, ?),
            acknowledged_by = COALESCE(acknowledged_by, ?)
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).run(now, actor, targetId, ctx.tenantId);
      return { ok: true, action: "acknowledge", message: `incident ${targetId} acknowledged` };
    } catch {
      return { ok: false, error: "database error", code: "EXEC_ERROR" };
    }
  }

  if (kind === "mitigate" && targetType === "incident") {
    const { getDashboardDb, isDashboardDbEnabled } = await import("../db/dashboard.ts");
    if (!isDashboardDbEnabled()) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    const db = getDashboardDb();
    if (!db) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    try {
      const now = Date.now();
      const ctx = getCurrentTenantContext();
      const actor = ctx.actor ?? "operator";
      const existing = db.query(`
        SELECT id FROM reasoner_incidents
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).get(targetId, ctx.tenantId) as { id: string } | null;
      if (!existing) return { ok: false, error: "incident not found", code: "NOT_FOUND" };
      db.query(
        `UPDATE reasoner_incidents SET mitigated_at = ?, mitigated_by = ? WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`
      ).run(now, actor, targetId, ctx.tenantId);
      return { ok: true, action: "mitigate", message: `incident ${targetId} marked mitigating` };
    } catch {
      return { ok: false, error: "database error", code: "EXEC_ERROR" };
    }
  }

  if (kind === "resolve" && targetType === "incident") {
    const { getDashboardDb, isDashboardDbEnabled } = await import("../db/dashboard.ts");
    if (!isDashboardDbEnabled()) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    const db = getDashboardDb();
    if (!db) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    try {
      const now = Date.now();
      const ctx = getCurrentTenantContext();
      const existing = db.query(`
        SELECT id FROM reasoner_incidents
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).get(targetId, ctx.tenantId) as { id: string } | null;
      if (!existing) return { ok: false, error: "incident not found", code: "NOT_FOUND" };
      db.query(`
        UPDATE reasoner_incidents
        SET status = 'resolved',
            resolved_at = COALESCE(resolved_at, ?)
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).run(now, targetId, ctx.tenantId);
      return { ok: true, action: "resolve", message: `incident ${targetId} resolved` };
    } catch {
      return { ok: false, error: "database error", code: "EXEC_ERROR" };
    }
  }

  if (kind === "mute" && targetType === "incident") {
    const { getDashboardDb, isDashboardDbEnabled } = await import("../db/dashboard.ts");
    if (!isDashboardDbEnabled()) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    const db = getDashboardDb();
    if (!db) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    try {
      const now = Date.now();
      const ctx = getCurrentTenantContext();
      const actor = ctx.actor ?? "operator";
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2_000) : "";
      const rawDuration = body.params?.durationMs;
      const durationMs = typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration > 0
        ? Math.min(rawDuration, 90 * 24 * 60 * 60 * 1000)
        : null;
      const mutedUntil = durationMs !== null ? now + durationMs : null;
      const existing = db.query(`
        SELECT id FROM reasoner_incidents
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).get(targetId, ctx.tenantId) as { id: string } | null;
      if (!existing) return { ok: false, error: "incident not found", code: "NOT_FOUND" };
      db.query(`
        UPDATE reasoner_incidents
        SET muted_at = ?,
            muted_by = ?,
            mute_reason = ?,
            muted_until = ?
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).run(now, actor, reason, mutedUntil, targetId, ctx.tenantId);
      const untilText = mutedUntil !== null ? ` until ${new Date(mutedUntil).toISOString()}` : " until unmuted";
      return { ok: true, action: "mute", message: `incident ${targetId} muted${untilText}` };
    } catch {
      return { ok: false, error: "database error", code: "EXEC_ERROR" };
    }
  }

  if (kind === "unmute" && targetType === "incident") {
    const { getDashboardDb, isDashboardDbEnabled } = await import("../db/dashboard.ts");
    if (!isDashboardDbEnabled()) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    const db = getDashboardDb();
    if (!db) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    try {
      const ctx = getCurrentTenantContext();
      const existing = db.query(`
        SELECT id FROM reasoner_incidents
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).get(targetId, ctx.tenantId) as { id: string } | null;
      if (!existing) return { ok: false, error: "incident not found", code: "NOT_FOUND" };
      db.query(`
        UPDATE reasoner_incidents
        SET muted_at = NULL,
            muted_by = NULL,
            mute_reason = NULL,
            muted_until = NULL
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).run(targetId, ctx.tenantId);
      return { ok: true, action: "unmute", message: `incident ${targetId} unmuted` };
    } catch {
      return { ok: false, error: "database error", code: "EXEC_ERROR" };
    }
  }

  if (kind === "escalate" && targetType === "incident") {
    const { getDashboardDb, isDashboardDbEnabled } = await import("../db/dashboard.ts");
    if (!isDashboardDbEnabled()) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    const db = getDashboardDb();
    if (!db) return { ok: false, error: "database unavailable", code: "EXEC_ERROR" };
    try {
      const ctx = getCurrentTenantContext();
      const incident = db.query(`
        SELECT i.id, i.failure_class, i.title, i.first_seen, i.last_seen, i.occurrence_count,
               i.representative_pass_id, i.status, i.escalated_workflow_id,
               d.root_cause, d.evidence_json, d.suggested_actions_json
        FROM reasoner_incidents i
        LEFT JOIN reasoner_diagnoses d ON d.id = i.representative_diagnosis_id
        WHERE i.id = ? AND (i.tenant_id = ? OR i.tenant_id IS NULL)
      `).get(targetId, ctx.tenantId) as EscalationIncidentRow | null;
      if (!incident) return { ok: false, error: "incident not found", code: "NOT_FOUND" };

      const { createBuilderWorkflow, readBuilderWorkflow, DEFAULT_WORKFLOW_CONFIG } = await import("../builder/store.ts");

      // Idempotency: an already-escalated incident returns the existing
      // workflow instead of creating a duplicate.
      if (incident.escalated_workflow_id) {
        const existing = readBuilderWorkflow(incident.escalated_workflow_id);
        if (existing) {
          return {
            ok: true,
            action: "escalate",
            message: `incident ${targetId} is already escalated to workflow ${existing.id}`,
            result: { workflowId: existing.id, planFile: existing.planFile, alreadyEscalated: true },
          };
        }
      }

      // Same joins detectRecurringIncidents uses: how often this
      // (failure_class, title) condition recurred in the trailing 7 days.
      const recurrence = db.query(`
        SELECT COUNT(*) AS n, SUM(status = 'open') AS open_count
        FROM reasoner_incidents
        WHERE failure_class = ? AND title = ? AND first_seen >= ?
          AND (tenant_id = ? OR tenant_id IS NULL)
      `).get(incident.failure_class, incident.title, Date.now() - 7 * 24 * 60 * 60 * 1000, ctx.tenantId) as { n: number; open_count: number | null };

      // Project = the incident's workflow's project when resolvable via its
      // representative pass, else the control-surface repo itself.
      const passRow = db.query(`
        SELECT workflow_id FROM builder_passes WHERE id = ? LIMIT 1
      `).get(incident.representative_pass_id) as { workflow_id: string } | null;
      const sourceWorkflow = passRow ? readBuilderWorkflow(passRow.workflow_id) : null;
      const projectRoot = sourceWorkflow?.projectRoot || CONTROL_SURFACE_ROOT;

      mkdirSync(ESCALATION_PLAN_DIR, { recursive: true });
      const planFile = join(ESCALATION_PLAN_DIR, `${safeEscalationId(incident.id)}-escalation.md`);
      writeFileSync(planFile, buildEscalationPlan(incident, recurrence), { encoding: "utf8" });

      let config;
      if (sourceWorkflow) {
        config = {
          ...sourceWorkflow.config,
          projectRoot,
          riskPolicy: { ...sourceWorkflow.config.riskPolicy, maxPasses: 1 },
          gitPolicy: { ...sourceWorkflow.config.gitPolicy, commit: "manual" as const, push: "never" as const },
        };
      } else {
        const { getProjectValidationProfile } = await import("../builder/validation-profile.ts");
        const profile = getProjectValidationProfile(projectRoot);
        const internal = profile.internal.length > 0
          ? profile.internal
          : profile.commands.length > 0 ? profile.commands : ["bun run check"];
        config = {
          ...DEFAULT_WORKFLOW_CONFIG,
          projectRoot,
          validationProfile: { ...DEFAULT_WORKFLOW_CONFIG.validationProfile, internal },
          riskPolicy: { ...DEFAULT_WORKFLOW_CONFIG.riskPolicy, maxPasses: 1 },
        };
      }

      const workflow = createBuilderWorkflow({
        name: `Escalated: ${incident.title}`.slice(0, 120),
        projectRoot,
        planFile,
        mode: "once",
        status: "draft",
        config,
      });

      db.query(`
        UPDATE reasoner_incidents
        SET escalated_workflow_id = ?
        WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)
      `).run(workflow.id, targetId, ctx.tenantId);

      writeActionAudit({
        actionKind: "incidents.escalate",
        actionId: `escalate:incident:${targetId}`,
        targetType: "incident",
        targetId,
        risk: "medium",
        reason: body.reason,
        request: { incidentId: targetId },
        result: `created draft workflow ${workflow.id}`,
        resultStatus: "success",
        resultJson: { workflowId: workflow.id, planFile },
        evidence: [
          { label: "Incident", kind: "api", ref: `/api/reasoner/incidents/${targetId}` },
          { label: "Escalation plan", kind: "file", ref: planFile },
        ],
        rollbackHint: "Delete the generated draft workflow from /builder if it is not needed.",
      });

      return {
        ok: true,
        action: "escalate",
        message: `incident ${targetId} escalated to draft workflow ${workflow.id}`,
        result: { workflowId: workflow.id, planFile },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "execution failed", code: "EXEC_ERROR" };
    }
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
    rollbackHint: result.ok ? rollbackHintForActionId(actionId) : undefined,
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
