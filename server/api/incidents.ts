import { readFileSync } from "node:fs";
import { ok, type ApiEnvelope } from "./types.ts";
import { getDoctorEntryErrorType, getFullLog } from "../adapters/doctor.ts";

const ALERTS_PATH = "/var/lib/mimule/pipeline-alerts.json";

export interface IncidentEntry {
  ts: number;
  type: "pipeline-failed" | "doctor-abandoned";
  slug: string;
  stage: string;
  errorType: string;
  severity: "error" | "warning";
}

export interface IncidentsDetail {
  entries: IncidentEntry[];
  stats: {
    total: number;
    last24h: number;
    byErrorType: { type: string; count: number }[];
    byStage: { stage: string; count: number }[];
  };
}

function readAlerts(): IncidentEntry[] {
  let raw: Record<string, number> = {};
  try { raw = JSON.parse(readFileSync(ALERTS_PATH, "utf8")); } catch { return []; }

  const entries: IncidentEntry[] = [];
  for (const [key, ts] of Object.entries(raw)) {
    // key format: pipeline-failed:<slug>:<stage>:<errorType>
    const parts = key.split(":");
    if (parts[0] !== "pipeline-failed" || parts.length < 4) continue;
    const slug = parts[1];
    const stage = parts[2];
    const errorType = parts.slice(3).join(":"); // errorType may contain colons
    entries.push({
      ts,
      type: "pipeline-failed",
      slug,
      stage,
      errorType,
      severity: errorType === "transport_timeout" || errorType === "capacity_rate_limit" ? "warning" : "error",
    });
  }
  return entries;
}

function readDoctorAbandons(): IncidentEntry[] {
  const entries = getFullLog({ });
  return entries
    .filter((e) => e.action === "dead-content" || e.action === "abandoned")
    .map((e) => ({
      ts: e.ts ? new Date(e.ts).getTime() : 0,
      type: "doctor-abandoned" as const,
      slug: e.slug ?? "",
      stage: e.stage ?? "",
      errorType: getDoctorEntryErrorType(e),
      severity: "error" as const,
    }))
    .filter((e) => e.ts > 0);
}

export function getIncidentEntries(): IncidentEntry[] {
  const alerts = readAlerts();
  const abandons = readDoctorAbandons();

  return [...alerts, ...abandons].sort((a, b) => b.ts - a.ts).slice(0, 500);
}

export function buildIncidentsDetail(): IncidentsDetail {
  const all = getIncidentEntries();

  const now = Date.now();
  const window24h = 24 * 60 * 60 * 1000;

  const errorTypeMap = new Map<string, number>();
  const stageMap = new Map<string, number>();
  let last24h = 0;

  for (const e of all) {
    if (now - e.ts < window24h) last24h++;
    errorTypeMap.set(e.errorType, (errorTypeMap.get(e.errorType) ?? 0) + 1);
    stageMap.set(e.stage, (stageMap.get(e.stage) ?? 0) + 1);
  }

  const byErrorType = [...errorTypeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([type, count]) => ({ type, count }));

  const byStage = [...stageMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stage, count]) => ({ stage, count }));

  return {
    entries: all,
    stats: { total: all.length, last24h, byErrorType, byStage },
  };
}

export async function incidentsHandler(): Promise<Response> {
  const data = buildIncidentsDetail();
  const envelope: ApiEnvelope<IncidentsDetail> = ok(data);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}
