// Loopback client for the isolated Hyperagent broker (/opt/hyperagent-broker).
// The broker — not this client — is the enforcement point for the tool
// allowlist, outbound DLP, per-task budget reservation, and the kill switch.
//
// D5 caller identity is self-asserted: any holder of the shared broker token
// can claim any caller name in `x-broker-caller` (see hyperagent-broker
// README, "Caller identity"). That means this module grants no access by
// itself — the real security boundary for the Control Surface's Hyperagent
// panel is this app's own auth + RBAC gate in server/api/hyperagent.ts.
//
// Every value returned here is untrusted provider-shaped data (the broker
// already strips it down to shaped identifiers/status/cost/counts). Callers
// of this module must render it as inert text, never as markup or
// instructions.

const BROKER_URL = "http://127.0.0.1:8787";
const CALLER = "control-surface";
const REQUEST_TIMEOUT_MS = 20_000;

export type BrokerResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

function brokerToken(): string {
  return process.env.HYPERAGENT_BROKER_TOKEN?.trim() || "";
}

function confirmationToken(): string {
  return process.env.HYPERAGENT_CONFIRMATION_TOKEN?.trim() || "";
}

/** Read-only broker calls (status, list_agents, get_thread) need only the broker token. */
export function hyperagentReadConfigured(): boolean {
  return Boolean(brokerToken());
}

/** create_thread additionally needs the confirmation credential for the broker's confirm step. */
export function hyperagentSpendConfigured(): boolean {
  return Boolean(brokerToken() && confirmationToken());
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${brokerToken()}`,
    "x-broker-caller": CALLER,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function brokerFetch(path: string, init: RequestInit): Promise<BrokerResult> {
  let res: Response;
  try {
    res = await fetch(`${BROKER_URL}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return { ok: false, status: 502, error: "hyperagent broker is unreachable" };
  }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  if (!res.ok) {
    const message = typeof body.error === "string" ? body.error : `broker returned HTTP ${res.status}`;
    return { ok: false, status: res.status, error: message };
  }
  return { ok: true, status: res.status, body };
}

/** GET /health is open (no bearer token) and includes the kill-switch state. */
export async function getBrokerHealth(): Promise<BrokerResult> {
  return brokerFetch("/health", { method: "GET" });
}

export async function getBrokerStatus(): Promise<BrokerResult> {
  if (!hyperagentReadConfigured()) return { ok: false, status: 503, error: "hyperagent broker token is not configured" };
  return brokerFetch("/status", { method: "GET", headers: authHeaders() });
}

export async function listHyperagentAgents(): Promise<BrokerResult> {
  if (!hyperagentReadConfigured()) return { ok: false, status: 503, error: "hyperagent broker token is not configured" };
  return brokerFetch("/call", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ tool: "list_agents", arguments: {} }),
  });
}

export async function getHyperagentThread(threadId: string): Promise<BrokerResult> {
  if (!hyperagentReadConfigured()) return { ok: false, status: 503, error: "hyperagent broker token is not configured" };
  return brokerFetch("/call", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ tool: "get_thread", arguments: { threadId } }),
  });
}

// create_thread spends against the broker's budget. This follows the same
// confirm -> call two-step already used by /opt/hyperagent-broker/mcp.ts
// rather than inventing a new protocol: issue a single-use, argument-bound
// permit, then redeem it immediately server-side. The UI-level "deliberate
// human click" (confirmed === true + a reason) is enforced one layer up in
// server/api/hyperagent.ts before this function is ever called.
export async function createHyperagentThread(
  agentId: string,
  prompt: string,
  maxCostUsd: number,
): Promise<BrokerResult> {
  if (!hyperagentSpendConfigured()) return { ok: false, status: 503, error: "hyperagent broker spend credentials are not configured" };
  const args = { agentId, prompt };
  const permit = await brokerFetch("/confirm", {
    method: "POST",
    headers: authHeaders({ "x-broker-confirmation": confirmationToken() }),
    body: JSON.stringify({ tool: "create_thread", arguments: args, maxCostUsd }),
  });
  // Explicit `=== false` (not `!permit.ok`): with strict:false in this
  // project's tsconfig, TS fails to narrow a boolean-literal discriminated
  // union through negation, only through direct equality comparison.
  if (permit.ok === false) return permit;
  const confirmationTokenValue = permit.body.confirmationToken;
  if (typeof confirmationTokenValue !== "string") {
    return { ok: false, status: 502, error: "broker did not return a usable confirmation permit" };
  }
  return brokerFetch("/call", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ tool: "create_thread", arguments: args, confirmationToken: confirmationTokenValue }),
  });
}
