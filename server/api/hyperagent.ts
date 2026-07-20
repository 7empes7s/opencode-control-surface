// D5b — governed Control Surface Hyperagent panel + one spending action.
//
// Read-only surface (agent list, thread status, ledger, phase) is a pure
// relay of the broker's own shaped responses — never a second copy of its
// state. The one governed action, hyperagent.create_thread, spends real
// Hyperagent task credit, so it is never eligible for SAFE_AUTO_ACTIONS or
// any auto-apply tier: it is wired here as an explicit, role-gated,
// audited, human-confirmed POST only.
//
// Caller attribution to the broker (`x-broker-caller: control-surface`) is
// advisory, not a security boundary — the broker validates one shared
// bearer token and trusts the caller header as a label (see
// hyperagent-broker/README.md). The actual access control for this feature
// is this app's own auth (checkToken) and RBAC (requireMutation), enforced
// in server/api/router.ts before these handlers ever run.
import { writeActionAudit } from "../db/writer.ts";
import {
  createHyperagentThread,
  getBrokerHealth,
  getBrokerStatus,
  getHyperagentThread,
  hyperagentReadConfigured,
  hyperagentSpendConfigured,
  listHyperagentAgents,
} from "../hyperagent/client.ts";

const MAX_PROMPT_LENGTH = 4_000;
const MAX_AGENT_ID_LENGTH = 200;
const DEFAULT_MAX_COST_USD = 1;
const MAX_PER_TASK_USD = 25;

export const HYPERAGENT_ATTRIBUTION_CAVEAT =
  "Broker caller attribution is advisory only: the Hyperagent broker validates one shared token and " +
  "trusts a self-asserted caller label, so it cannot cryptographically prove this call came from the " +
  "Control Surface. Access control for this panel is enforced by this app's own sign-in and role check, " +
  "not by the broker.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// GET /api/hyperagent/status — phase, budget/ledger, kill-switch state. All
// values are relayed verbatim from the broker's /health and /status.
export async function hyperagentStatusHandler(_req: Request): Promise<Response> {
  if (!hyperagentReadConfigured()) {
    return json({ data: { configured: false, attributionCaveat: HYPERAGENT_ATTRIBUTION_CAVEAT } });
  }

  const [health, status] = await Promise.all([getBrokerHealth(), getBrokerStatus()]);
  // Explicit `=== false` (not `!status.ok`): with strict:false in this
  // project's tsconfig, TS fails to narrow a boolean-literal discriminated
  // union through negation, only through direct equality comparison.
  if (status.ok === false) {
    return json({ data: { configured: true, error: status.error, attributionCaveat: HYPERAGENT_ATTRIBUTION_CAVEAT } });
  }

  return json({
    data: {
      configured: true,
      spendConfigured: hyperagentSpendConfigured(),
      phase: status.body.phase ?? null,
      budget: status.body.budget ?? null,
      allowedCallers: status.body.allowedCallers ?? [],
      toolAllowlist: status.body.toolAllowlist ?? [],
      disabled: health.ok ? Boolean(health.body.disabled) : null,
      attributionCaveat: HYPERAGENT_ATTRIBUTION_CAVEAT,
    },
  });
}

// GET /api/hyperagent/agents — read-only agent list, shaped by the broker.
export async function hyperagentAgentsHandler(_req: Request): Promise<Response> {
  if (!hyperagentReadConfigured()) return json({ error: "hyperagent broker token is not configured" }, 503);
  const result = await listHyperagentAgents();
  if (result.ok === false) return json({ error: result.error }, result.status);
  return json({ data: { agents: result.body.agents ?? [], count: result.body.count ?? 0 } });
}

// GET /api/hyperagent/threads/:threadId — read-only thread status.
export async function hyperagentThreadHandler(_req: Request, threadId: string): Promise<Response> {
  if (!threadId) return json({ error: "threadId required" }, 400);
  if (!hyperagentReadConfigured()) return json({ error: "hyperagent broker token is not configured" }, 503);
  const result = await getHyperagentThread(threadId);
  if (result.ok === false) return json({ error: result.error }, result.status);
  return json({ data: { thread: result.body.thread ?? null } });
}

interface CreateThreadRequestBody {
  agentId?: unknown;
  prompt?: unknown;
  maxCostUsd?: unknown;
  confirmed?: unknown;
  reason?: unknown;
}

// POST /api/hyperagent/create-thread — the one governed, spending action.
// Role gate (operator/owner) is enforced by requireMutation in router.ts
// before this handler runs; this function only re-validates request shape
// and writes the audit trail.
export async function hyperagentCreateThreadHandler(req: Request): Promise<Response> {
  let body: CreateThreadRequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const maxCostUsd = typeof body.maxCostUsd === "number" && Number.isFinite(body.maxCostUsd)
    ? body.maxCostUsd
    : DEFAULT_MAX_COST_USD;

  const audit = (result: { resultStatus: "success" | "failed"; error?: string; resultJson?: unknown }) => {
    writeActionAudit({
      actionKind: "hyperagent.create_thread",
      targetType: "hyperagent-thread",
      targetId: agentId || "unknown",
      risk: "high",
      reason: reason || undefined,
      request: { agentId, promptLength: prompt.length, maxCostUsd },
      resultStatus: result.resultStatus,
      result: result.resultStatus === "success" ? "hyperagent thread created" : undefined,
      resultJson: result.resultJson,
      // Broker refusal text is carried through verbatim, never reworded.
      error: result.error,
    });
  };

  if (!agentId || agentId.length > MAX_AGENT_ID_LENGTH) {
    audit({ resultStatus: "failed", error: "agentId is required" });
    return json({ error: "agentId is required" }, 400);
  }
  if (!prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    audit({ resultStatus: "failed", error: `prompt is required and must be under ${MAX_PROMPT_LENGTH} characters` });
    return json({ error: `prompt is required and must be under ${MAX_PROMPT_LENGTH} characters` }, 400);
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > MAX_PER_TASK_USD) {
    audit({ resultStatus: "failed", error: `maxCostUsd must be between 0 and ${MAX_PER_TASK_USD}` });
    return json({ error: `maxCostUsd must be between 0 and ${MAX_PER_TASK_USD}` }, 400);
  }
  if (body.confirmed !== true) {
    audit({ resultStatus: "failed", error: "confirmation required" });
    return json({ error: "confirmation required" }, 400);
  }
  if (!reason) {
    audit({ resultStatus: "failed", error: "reason required" });
    return json({ error: "reason required" }, 400);
  }

  const result = await createHyperagentThread(agentId, prompt, maxCostUsd);

  if (result.ok === false) {
    audit({ resultStatus: "failed", error: result.error });
    return json({ error: result.error }, result.status);
  }

  audit({ resultStatus: "success", resultJson: result.body });
  return json({ data: result.body });
}
