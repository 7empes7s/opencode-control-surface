import { getDashboardDb } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { complete } from "../gateway/client.ts";
import { listInsights } from "./store.ts";
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

type HistoryLine = { ts: number | null; text: string };

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

function sourceFamily(sourceKey: string | null | undefined): string | null {
  if (!sourceKey) return null;
  const parts = sourceKey.split(":").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? null;
  return `${parts[0]}:${parts[1]}`;
}

function formatInsightContext(insights: Insight[]): string {
  if (insights.length === 0) return "- (none)";
  return insights.map((item) => {
    const age = item.createdAt ? new Date(item.createdAt).toISOString() : "unknown-time";
    const source = item.sourceKey ? ` source=${item.sourceKey}` : "";
    const summary = item.plainSummary.length > 140 ? `${item.plainSummary.slice(0, 137)}...` : item.plainSummary;
    return `- [${item.status}/${item.severity}/${item.domain}] ${item.title} (${age}${source}): ${summary}`;
  }).join("\n");
}

function formatHistoryContext(lines: HistoryLine[]): string {
  if (lines.length === 0) return "- (none)";
  return lines
    .map((line) => {
      const when = line.ts ? new Date(line.ts).toISOString() : "unknown-time";
      return `- [${when}] ${line.text}`;
    })
    .join("\n");
}

function compact(value: unknown, max = 160): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function readRecentActionHistory(limit = 6): HistoryLine[] {
  const db = getDashboardDb();
  if (!db) return [];
  try {
    const rows = db.query(`
      SELECT ts, actor, action_kind, action_id, target_type, target_id, result_status, result, error
      FROM action_audit
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit) as Array<{
      ts: number | null;
      actor: string | null;
      action_kind: string;
      action_id: string | null;
      target_type: string | null;
      target_id: string | null;
      result_status: string | null;
      result: string | null;
      error: string | null;
    }>;
    return rows.map((row) => ({
      ts: row.ts,
      text: `action ${row.action_kind}${row.action_id ? `/${row.action_id}` : ""} by ${row.actor ?? "unknown"} -> ${row.result_status ?? "unknown"}${row.target_type || row.target_id ? ` target=${row.target_type ?? "?"}:${row.target_id ?? "?"}` : ""}${row.error ? ` error=${compact(row.error, 100)}` : row.result ? ` result=${compact(row.result, 100)}` : ""}`,
    }));
  } catch {
    return [];
  }
}

function readRecentConfigHistory(limit = 4): HistoryLine[] {
  const db = getDashboardDb();
  if (!db) return [];
  try {
    const rows = db.query(`
      SELECT ts, key, changed_by, note
      FROM config_changes
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit) as Array<{ ts: number; key: string; changed_by: string | null; note: string | null }>;
    return rows.map((row) => ({
      ts: row.ts,
      text: `config ${row.key} changed by ${row.changed_by ?? "unknown"}${row.note ? ` (${compact(row.note, 100)})` : ""}`,
    }));
  } catch {
    return [];
  }
}

function readRecentJobHistory(limit = 4): HistoryLine[] {
  const db = getDashboardDb();
  if (!db) return [];
  try {
    const rows = db.query(`
      SELECT COALESCE(finished_at, started_at, ts) AS ts, kind, state, status, target_type, target_id, exit_code, error
      FROM jobs
      ORDER BY COALESCE(finished_at, started_at, ts) DESC
      LIMIT ?
    `).all(limit) as Array<{
      ts: number | null;
      kind: string;
      state: string;
      status: string | null;
      target_type: string | null;
      target_id: string | null;
      exit_code: number | null;
      error: string | null;
    }>;
    return rows.map((row) => ({
      ts: row.ts,
      text: `job ${row.kind} ${row.state}${row.status ? `/${row.status}` : ""}${row.target_type || row.target_id ? ` target=${row.target_type ?? "?"}:${row.target_id ?? "?"}` : ""}${row.exit_code !== null ? ` exit=${row.exit_code}` : ""}${row.error ? ` error=${compact(row.error, 100)}` : ""}`,
    }));
  } catch {
    return [];
  }
}

function getAnalysisPromptContext(insight: Insight): { related: Insight[]; recent: Insight[]; history: HistoryLine[] } {
  if (!getDashboardDb()) return { related: [], recent: [], history: [] };
  try {
    const all = listInsights("all")
      .filter((item) => item.id !== insight.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    const family = sourceFamily(insight.sourceKey);
    const related = all
      .filter((item) => {
        const itemFamily = sourceFamily(item.sourceKey);
        return item.domain === insight.domain || (!!family && itemFamily === family);
      })
      .slice(0, 5);
    const recent = all.slice(0, 6);
    const history = [
      ...readRecentActionHistory(),
      ...readRecentConfigHistory(),
      ...readRecentJobHistory(),
    ]
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, 10);
    return { related, recent, history };
  } catch {
    return { related: [], recent: [], history: [] };
  }
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
  const context = getAnalysisPromptContext(insight);
  return [
    "You are the site reliability advisor for an AI-operated media stack.",
    "A monitoring detector raised the finding below. Analyse it and respond with STRICT JSON only.",
    "Use the recent history and related findings to identify correlated failures or recurring root causes.",
    "",
    `Finding title: ${insight.title}`,
    `Domain: ${insight.domain}`,
    `Severity: ${insight.severity}`,
    `Detector summary: ${insight.plainSummary}`,
    `Operator page: ${insight.manualPageHref}`,
    "Evidence:",
    evidence,
    "",
    "Recent related findings (same domain or detector family):",
    formatInsightContext(context.related),
    "",
    "Recent platform finding history:",
    formatInsightContext(context.recent),
    "",
    "Recent platform actions, jobs, and config changes:",
    formatHistoryContext(context.history),
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
