import { getDashboardDb } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { complete } from "../gateway/client.ts";
import type { Insight } from "./types.ts";

export interface AiAnalysis {
  signature: string;
  insightId: string;
  summary: string;
  rootCause: string;
  recommendedAction: string;
  confidence: number;
  model: string;
  generatedAt: number;
}

// Re-analyse a finding at most this often unless forced.
const FRESHNESS_MS = 6 * 60 * 60 * 1000;
// Logical model — LiteLLM resolves local-first then the cloud fallback chain.
const ANALYSIS_MODEL = "editorial-heavy";

type AiRow = {
  signature: string;
  insight_id: string;
  summary: string;
  root_cause: string;
  recommended_action: string;
  confidence: number;
  model: string;
  generated_at: number;
};

function mapRow(row: AiRow): AiAnalysis {
  return {
    signature: row.signature,
    insightId: row.insight_id,
    summary: row.summary,
    rootCause: row.root_cause,
    recommendedAction: row.recommended_action,
    confidence: row.confidence,
    model: row.model,
    generatedAt: row.generated_at,
  };
}

// Stable cache key. Re-keys on severity so a finding that escalates is re-analysed.
export function signatureFor(insight: Pick<Insight, "id" | "severity" | "sourceKey">): string {
  return `${insight.sourceKey ?? insight.id}:${insight.severity}`;
}

export function getAiAnalysis(insightId: string): AiAnalysis | null {
  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query(
    `SELECT signature, insight_id, summary, root_cause, recommended_action, confidence, model, generated_at
     FROM ai_analysis WHERE insight_id = ? ORDER BY generated_at DESC LIMIT 1`,
  ).get(insightId) as AiRow | null;
  return row ? mapRow(row) : null;
}

export function getAiAnalysisBySignature(signature: string): AiAnalysis | null {
  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query(
    `SELECT signature, insight_id, summary, root_cause, recommended_action, confidence, model, generated_at
     FROM ai_analysis WHERE signature = ?`,
  ).get(signature) as AiRow | null;
  return row ? mapRow(row) : null;
}

export function upsertAiAnalysis(input: Omit<AiAnalysis, "generatedAt"> & { generatedAt?: number }): AiAnalysis | null {
  const db = getDashboardDb();
  if (!db) return null;
  const tenantId = getCurrentTenantContext().tenantId;
  const generatedAt = input.generatedAt ?? Date.now();
  db.query(
    `INSERT INTO ai_analysis (signature, insight_id, summary, root_cause, recommended_action, confidence, model, tenant_id, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(signature) DO UPDATE SET
       insight_id = excluded.insight_id,
       summary = excluded.summary,
       root_cause = excluded.root_cause,
       recommended_action = excluded.recommended_action,
       confidence = excluded.confidence,
       model = excluded.model,
       generated_at = excluded.generated_at`,
  ).run(
    input.signature, input.insightId, input.summary, input.rootCause,
    input.recommendedAction, Math.max(0, Math.min(1, input.confidence)),
    input.model, tenantId, generatedAt,
  );
  return getAiAnalysisBySignature(input.signature);
}

export function buildAnalysisPrompt(insight: Insight): string {
  const evidence = insight.evidenceRefs.map((e) => `- ${e.label} (${e.kind}: ${e.ref})`).join("\n") || "- (none)";
  return [
    "You are the site reliability advisor for an AI-operated media stack.",
    "A monitoring detector raised the finding below. Analyse it and respond with STRICT JSON only.",
    "",
    `Finding title: ${insight.title}`,
    `Domain: ${insight.domain}`,
    `Severity: ${insight.severity}`,
    `Detector summary: ${insight.plainSummary}`,
    `Operator page: ${insight.manualPageHref}`,
    "Evidence:",
    evidence,
    "",
    "Respond with ONLY this JSON shape (no prose, no markdown fences):",
    `{"summary": "<=2 sentence operator-facing explanation", "root_cause": "most likely root cause", "recommended_action": "the single best next action", "confidence": 0.0-1.0}`,
  ].join("\n");
}

// Tolerant JSON extraction — models sometimes wrap JSON in prose or fences.
export function parseAnalysisJson(content: string): { summary: string; rootCause: string; recommendedAction: string; confidence: number } | null {
  if (!content) return null;
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; }
  catch { return null; }
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const rootCause = typeof obj.root_cause === "string" ? obj.root_cause.trim() : "";
  const recommendedAction = typeof obj.recommended_action === "string" ? obj.recommended_action.trim() : "";
  if (!summary || !rootCause || !recommendedAction) return null;
  const confRaw = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0.5;
  return { summary, rootCause, recommendedAction, confidence };
}

function isFresh(analysis: AiAnalysis | null, now: number): boolean {
  return !!analysis && now - analysis.generatedAt < FRESHNESS_MS;
}

// Enrich a single finding. Never throws; returns null on any failure so the
// caller (a scan or a request) is never blocked by the model layer.
export async function enrichInsight(insight: Insight, opts: { force?: boolean } = {}): Promise<AiAnalysis | null> {
  if (!getDashboardDb()) return null;
  const signature = signatureFor(insight);
  const existing = getAiAnalysisBySignature(signature);
  if (!opts.force && isFresh(existing, Date.now())) return existing;

  try {
    const messages = [{ role: "user" as const, content: buildAnalysisPrompt(insight) }];
    const response = await complete(ANALYSIS_MODEL, messages, {
      temperature: 0.2,
      maxTokens: 600,
      timeoutMs: 60_000,
      caller: "insights-ai",
    });
    const content = response.choices?.[0]?.message?.content ?? "";
    const parsed = parseAnalysisJson(content);
    if (!parsed) return existing;
    const model = response.model ?? ANALYSIS_MODEL;
    return upsertAiAnalysis({
      signature,
      insightId: insight.id,
      summary: parsed.summary,
      rootCause: parsed.rootCause,
      recommendedAction: parsed.recommendedAction,
      confidence: parsed.confidence,
      model,
    });
  } catch (err) {
    console.error("[insights-ai] enrichment failed", err instanceof Error ? err.message : err);
    return existing;
  }
}

let enrichmentInFlight = false;

// Fire-and-forget batch enrichment for open findings lacking fresh analysis.
// Sequential + capped to avoid hammering the model gateway. A module-level guard
// stops a scheduler tick and a manual scan from overlapping. Returns count enriched.
export async function enrichOpenInsights(insights: Insight[], limit = 6): Promise<number> {
  if (!getDashboardDb() || enrichmentInFlight) return 0;
  enrichmentInFlight = true;
  try {
    const now = Date.now();
    const stale = insights.filter((i) => i.status === "open" && !isFresh(getAiAnalysisBySignature(signatureFor(i)), now));
    let enriched = 0;
    for (const insight of stale.slice(0, limit)) {
      const result = await enrichInsight(insight);
      if (result) enriched++;
    }
    return enriched;
  } finally {
    enrichmentInFlight = false;
  }
}
