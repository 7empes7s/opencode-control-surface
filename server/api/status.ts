import { readFileSync } from "node:fs";

const DEFAULT_SENTINEL_HEALTH_PATH = "/var/lib/mimule/product-health.json";

type SentinelCard = {
  score?: number | null;
  fails?: number | null;
  warns?: number | null;
  findings?: Array<Record<string, unknown>>;
  checkedAt?: number | null;
  checkedAtISO?: string | null;
  agents?: Record<string, { ok?: boolean }>;
};

type AgentStatus = { name: string; ok: boolean };

export type PublicStatus = "operational" | "degraded" | "down";

export interface PublicStatusPayload {
  status: PublicStatus;
  score: number | null;
  checkedAt: string | null;
  uptimeSec: number;
  agents: AgentStatus[];
  services: Array<Record<string, never>>;
  generatedAt: string;
}

function getSentinelHealthPath(): string {
  return process.env.SENTINEL_HEALTH_PATH ?? DEFAULT_SENTINEL_HEALTH_PATH;
}

function readSentinelCard(): SentinelCard | null {
  try {
    return JSON.parse(readFileSync(getSentinelHealthPath(), "utf8")) as SentinelCard;
  } catch {
    return null;
  }
}

function readUptimeSec(): number {
  try {
    const raw = readFileSync("/proc/uptime", "utf8").split(" ")[0] ?? "0";
    return Math.max(0, Math.floor(parseFloat(raw)));
  } catch {
    return 0;
  }
}

function mapStatus(score: number | null | undefined): PublicStatus {
  if (score == null || !Number.isFinite(score)) return "degraded";
  if (score >= 90) return "operational";
  if (score >= 60) return "degraded";
  return "down";
}

function checkedAtToIso(card: SentinelCard | null): string | null {
  if (card?.checkedAtISO) return card.checkedAtISO;
  if (typeof card?.checkedAt === "number" && Number.isFinite(card.checkedAt)) {
    return new Date(card.checkedAt * 1000).toISOString();
  }
  return null;
}

function readAgents(card: SentinelCard | null): AgentStatus[] {
  if (!card || !card.agents || typeof card.agents !== "object") return [];
  return Object.entries(card.agents).map(([name, info]) => ({
    name,
    ok: Boolean(info?.ok),
  }));
}

export function publicStatusHandler(): Response {
  const card = readSentinelCard();
  const score = card?.score ?? null;
  const status: PublicStatus = mapStatus(score);

  const payload: PublicStatusPayload = {
    status,
    score: score ?? null,
    checkedAt: checkedAtToIso(card),
    uptimeSec: readUptimeSec(),
    agents: readAgents(card),
    services: [],
    generatedAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
