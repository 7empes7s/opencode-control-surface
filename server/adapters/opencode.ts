// Request-scoped OpenCode summary for the home dashboard. Reachability may be
// cached globally; visibility-derived counts never are.

import { getCurrentAuthenticatedUser } from "../auth/session.ts";
import { resolveRole } from "../governance/rbac.ts";
import { listAgentSessions } from "../agentWorkspace/registry.ts";

export type OpenCodeSessionSummary = {
  reachable: boolean;
  sessionCount: number | null;
  active24h: number | null;
  latestUpdatedAt: number | null;
  error: string | null;
};

type OperationalSummary = Pick<OpenCodeSessionSummary, "reachable" | "error">;

const OPENCODE_URL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
const PROBE_TIMEOUT_MS = Number(process.env.OPENCODE_PROBE_TIMEOUT_MS) || 2000;
const CACHE_TTL_MS = 30_000;

let cache: { value: OperationalSummary; ts: number } | null = null;
let inFlight: Promise<OperationalSummary> | null = null;

export function resetOpenCodeOperationalCacheForTests(): void {
  cache = null;
  inFlight = null;
}

function visibleSummary(): Pick<OpenCodeSessionSummary, "sessionCount" | "active24h" | "latestUpdatedAt"> {
  const user = getCurrentAuthenticatedUser();
  if (!user) return { sessionCount: null, active24h: null, latestUpdatedAt: null };
  const sessions = listAgentSessions({
    tenantId: user.tenantId,
    userId: user.userId,
    role: resolveRole(user),
  }, "opencode");
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return {
    sessionCount: sessions.length,
    active24h: sessions.filter((session) => session.updatedAt >= dayAgo).length,
    latestUpdatedAt: sessions.reduce<number | null>(
      (latest, session) => latest === null || session.updatedAt > latest ? session.updatedAt : latest,
      null,
    ),
  };
}

export async function getOpenCodeOperationalSummary(): Promise<OperationalSummary> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.value;
  if (inFlight) return await inFlight;

  inFlight = probeOperationalStatus();
  try {
    const value = await inFlight;
    cache = { value, ts: Date.now() };
    return value;
  } finally {
    inFlight = null;
  }
}

export async function getOpenCodeSessionSummary(): Promise<OpenCodeSessionSummary> {
  return { ...await getOpenCodeOperationalSummary(), ...visibleSummary() };
}

async function probeOperationalStatus(): Promise<OperationalSummary> {
  try {
    const res = await fetch(`${OPENCODE_URL}/session?limit=1`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const sessions = await res.json() as unknown;
    return Array.isArray(sessions)
      ? { reachable: true, error: null }
      : { reachable: false, error: "unexpected response shape" };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
    };
  }
}
