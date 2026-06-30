import { ok, type ApiEnvelope } from "./types.ts";
import { listInsights } from "../insights/store.ts";
import type { Insight } from "../insights/types.ts";

export interface IncidentEntry {
  ts: number;
  type: "pipeline-failed" | "doctor-abandoned" | "insight";
  slug: string;
  stage: string;
  errorType: string;
  severity: "error" | "warning";
  insightId?: string;
  sourceKey?: string | null;
  title?: string;
  manualPageHref?: string;
  detectionsHref?: string;
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

function isIncidentGrade(insight: Insight): boolean {
  if (insight.status !== "open") return false;
  if (!["ops", "security", "build"].includes(insight.domain)) return false;
  if (insight.severity === "high" || insight.severity === "critical") return true;
  return (insight.sourceKey ?? "").startsWith("health:sentinel:");
}

function entryFromInsight(insight: Insight): IncidentEntry {
  const source = insight.sourceKey ?? insight.id;
  return {
    ts: insight.createdAt,
    type: "insight",
    slug: source,
    stage: insight.domain,
    errorType: insight.severity,
    severity: insight.severity === "critical" || insight.severity === "high" ? "error" : "warning",
    insightId: insight.id,
    sourceKey: insight.sourceKey,
    title: insight.title,
    manualPageHref: insight.manualPageHref,
    detectionsHref: `/insights?focus=${encodeURIComponent(source)}`,
  };
}

export function getIncidentEntries(): IncidentEntry[] {
  return listInsights("open")
    .filter(isIncidentGrade)
    .map(entryFromInsight)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 500);
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
