// Lightweight probe of the OpenCode server's session list for the home dashboard.
// Honest degrade: when the server is unreachable the widget says so — no fake zeros.

export type OpenCodeSessionSummary = {
  reachable: boolean;
  sessionCount: number | null;
  active24h: number | null;
  latestUpdatedAt: number | null;
  error: string | null;
};

const OPENCODE_URL = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
const PROBE_TIMEOUT_MS = Number(process.env.OPENCODE_PROBE_TIMEOUT_MS) || 2000;
const CACHE_TTL_MS = 30_000;

let cache: { value: OpenCodeSessionSummary; ts: number } | null = null;
let inFlight: Promise<OpenCodeSessionSummary> | null = null;

type OpenCodeSession = { id?: string; time?: { created?: number; updated?: number } };

export async function getOpenCodeSessionSummary(): Promise<OpenCodeSessionSummary> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.value;
  }
  if (inFlight) return inFlight;

  inFlight = probeSessions();
  try {
    const value = await inFlight;
    cache = { value, ts: Date.now() };
    return value;
  } finally {
    inFlight = null;
  }
}

async function probeSessions(): Promise<OpenCodeSessionSummary> {
  try {
    const res = await fetch(`${OPENCODE_URL}/session`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      return { reachable: false, sessionCount: null, active24h: null, latestUpdatedAt: null, error: `HTTP ${res.status}` };
    }
    const sessions = await res.json() as unknown;
    if (!Array.isArray(sessions)) {
      return { reachable: false, sessionCount: null, active24h: null, latestUpdatedAt: null, error: "unexpected response shape" };
    }

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let active24h = 0;
    let latestUpdatedAt: number | null = null;
    for (const session of sessions as OpenCodeSession[]) {
      const updated = session?.time?.updated ?? session?.time?.created ?? null;
      if (typeof updated !== "number") continue;
      if (updated >= dayAgo) active24h += 1;
      if (latestUpdatedAt === null || updated > latestUpdatedAt) latestUpdatedAt = updated;
    }

    return { reachable: true, sessionCount: sessions.length, active24h, latestUpdatedAt, error: null };
  } catch (error) {
    return {
      reachable: false,
      sessionCount: null,
      active24h: null,
      latestUpdatedAt: null,
      error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
    };
  }
}
