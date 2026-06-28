import { useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, RefreshCw, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";
import type { ApiEnvelope, EvidenceRef } from "../../server/api/types";
import type { Insight, InsightStatus } from "../../server/insights/types";

type AiAnalysis = {
  summary: string;
  rootCause: string;
  recommendedAction: string;
  confidence: number;
  model: string;
  generatedAt: number;
};

type InsightWithAi = Insight & { aiAnalysis?: AiAnalysis | null; riskTier?: "auto" | "review" | "none" };

type InsightsPayload = {
  insights: InsightWithAi[];
  openCount: number;
};

type StatusFilter = "open" | "applied" | "dismissed" | "resolved" | "all";

const STATUS_LABEL: Record<StatusFilter, string> = {
  open: "Open",
  applied: "Applied",
  dismissed: "Dismissed",
  resolved: "Resolved itself — verified by the scanner",
  all: "All",
};

const DOMAIN_LABEL: Record<Insight["domain"], string> = {
  cost: "Cost",
  security: "Security",
  build: "Build",
  data: "Data",
  ops: "Operations",
};

// Operations (stack health) leads — it is the most operationally urgent group.
const DOMAIN_ORDER: Insight["domain"][] = ["ops", "security", "cost", "build", "data"];

const SEVERITY_RANK: Record<Insight["severity"], number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function severityClass(severity: Insight["severity"]): string {
  if (severity === "critical" || severity === "high") return "red";
  if (severity === "medium") return "amber";
  if (severity === "low") return "blue";
  return "gray";
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "high confidence";
  if (confidence >= 0.6) return "medium confidence";
  return "needs review";
}

function EvidenceDrawer({ evidenceRefs }: { evidenceRefs: EvidenceRef[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="insight-evidence">
      <button type="button" className="insight-evidence-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Evidence
      </button>
      {open && (
        <div className="insight-evidence-list">
          {evidenceRefs.length === 0 ? (
            <div className="w-caption">No evidence reference was attached.</div>
          ) : evidenceRefs.map((ref, idx) => (
            <div key={`${ref.kind}-${ref.ref}-${idx}`} className="insight-evidence-row">
              <span className="pill gray">{ref.kind}</span>
              <span>{ref.label}</span>
              <span className="dim">{ref.redacted ? "redacted" : ref.ref}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function InsightsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const { data, loading, error, refresh } = useApi<InsightsPayload>(`/api/insights?status=${statusFilter}`, 30_000);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [bulkReasons, setBulkReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const groups: Record<Insight["domain"], InsightWithAi[]> = { cost: [], security: [], build: [], data: [], ops: [] };
    for (const insight of data?.insights ?? []) {
      groups[insight.domain].push(insight);
    }
    for (const domain of Object.keys(groups) as Insight["domain"][]) {
      groups[domain].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.createdAt - a.createdAt);
    }
    return groups;
  }, [data]);

  async function post(path: string, body: Record<string, unknown>) {
    const res = await authFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ error: "The request did not return a readable response." })) as ApiEnvelope<unknown> & { error?: string; data?: { message?: string } };
    if (!res.ok) throw new Error(json.error || json.data?.message || "The request could not be completed.");
    return json;
  }

  async function applyInsight(insight: Insight) {
    setBusyId(insight.id);
    setMessage(null);
    try {
      const reason = (reasons[insight.id] ?? "").trim();
      const result = await post(`/api/insights/${encodeURIComponent(insight.id)}/apply`, {
        confirmed: true,
        reason,
      });
      setMessage(result.data?.message ?? "The insight was applied and recorded.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The insight could not be applied.");
    } finally {
      setBusyId(null);
    }
  }

  async function dismissInsight(insight: Insight) {
    setBusyId(insight.id);
    setMessage(null);
    try {
      const reason = (reasons[insight.id] ?? "").trim();
      const result = await post(`/api/insights/${encodeURIComponent(insight.id)}/dismiss`, { reason });
      setMessage(result.data?.message ?? "The insight was dismissed.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The insight could not be dismissed.");
    } finally {
      setBusyId(null);
    }
  }

  async function reanalyze(insight: Insight) {
    setBusyId(`ai:${insight.id}`);
    setMessage(null);
    try {
      await post(`/api/insights/${encodeURIComponent(insight.id)}/reanalyze`, {});
      setMessage("The AI re-analysed this finding.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The finding could not be re-analysed right now.");
    } finally {
      setBusyId(null);
    }
  }

  async function scanNow() {
    setBusyId("scan");
    setMessage(null);
    try {
      await post("/api/insights/scan", {});
      setMessage("The inbox was refreshed from operations, security, cost, build, and data signals.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The scan could not be started.");
    } finally {
      setBusyId(null);
    }
  }

  async function applyGroup(domain: Insight["domain"]) {
    setBusyId(`bulk:${domain}`);
    setMessage(null);
    try {
      const result = await post("/api/insights/bulk-apply", {
        domain,
        reason: (bulkReasons[domain] ?? "").trim(),
        confirmed: true,
      });
      setMessage(result.data?.message ?? "Bulk apply finished.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Bulk apply could not be completed.");
    } finally {
      setBusyId(null);
    }
  }

  const openCount = data?.openCount ?? data?.insights.length ?? 0;

  return (
    <div className="dash-page insights-page">
      <section className="insights-hero">
        <div>
          <div className="dash-section-title">insights inbox</div>
          <h1>AI recommendations ready for review</h1>
          <p>
            Review plain-English findings, apply safe actions through the audited action engine, or open the manual page when a human should configure it.
          </p>
        </div>
        <div className="insights-hero-actions">
          <div className="insights-count">
            <Sparkles size={18} />
            <span>{openCount}</span>
            <small>open</small>
          </div>
          <select
            className="select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label="Filter insights by status"
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved itself — verified by the scanner</option>
            <option value="applied">Applied</option>
            <option value="dismissed">Dismissed</option>
            <option value="all">All</option>
          </select>
          <button type="button" className="btn" onClick={scanNow} disabled={busyId === "scan"}>
            <RefreshCw size={14} />
            Scan now
          </button>
        </div>
      </section>

      {message && <div className="insights-message"><CheckCircle2 size={15} />{message}</div>}
      {loading && !data && <div className="loading-panel">Loading insights from the inbox.</div>}
      {error && !data && <div className="loading-panel error">The insights inbox did not load. Try refreshing the page.</div>}

      {!loading && data && data.insights.length === 0 && (
        <div className="dash-section">
          <div className="empty-state">
            <ShieldCheck size={24} />
            <strong>{statusFilter === "open" ? "No open insights right now." : `No ${STATUS_LABEL[statusFilter].toLowerCase()} insights.`}</strong>
            {statusFilter === "open" && <span>Run a scan to refresh cost, security, build, and data checks.</span>}
          </div>
        </div>
      )}

      {DOMAIN_ORDER.map((domain) => {
        const insights = grouped[domain];
        if (insights.length === 0) return null;
        const actionableCount = insights.filter((i) => i.actionDescriptorId && i.status === "open").length;
        return (
          <section className="dash-section" key={domain}>
            <div className="insight-group-title">
              <span>{DOMAIN_LABEL[domain]}</span>
              <span className="pill gray">{insights.length}</span>
              <div className="insight-group-bulk">
                <input
                  value={bulkReasons[domain] ?? ""}
                  onChange={(e) => setBulkReasons((c) => ({ ...c, [domain]: e.target.value }))}
                  placeholder="Reason for applying all"
                  aria-label={`Reason for applying all ${DOMAIN_LABEL[domain]} insights`}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={actionableCount === 0 || busyId === `bulk:${domain}`}
                  onClick={() => applyGroup(domain)}
                  title={actionableCount === 0 ? "No one-click actions in this group" : "Apply every actionable insight in this group"}
                >
                  <CheckCircle2 size={14} />
                  Apply all safe ({actionableCount})
                </button>
              </div>
            </div>
            <div className="insight-card-list">
              {insights.map((insight) => (
                <article key={insight.id} className={`insight-card severity-${insight.severity}`}>
                  <div className="insight-card-head">
                    <div>
                      <div className="insight-title-row">
                        <span className={`pill ${severityClass(insight.severity)}`}>{insight.severity}</span>
                        <span className="pill blue">{confidenceLabel(insight.confidence)}</span>
                        {insight.status === "resolved" && (
                          <span className="pill green">Resolved itself — verified by the scanner</span>
                        )}
                        {insight.status === "applied" && (
                          <span className="pill green">{insight.riskTier === "auto" ? "Auto-applied ✓" : "Applied"}</span>
                        )}
                        {insight.status === "open" && insight.riskTier === "auto" && (
                          <span className="pill green" title="Safe, non-customer-facing fix — applied automatically on the next scan">Auto-fix</span>
                        )}
                        {insight.status === "dismissed" && <span className="pill gray">Dismissed</span>}
                      </div>
                      <h2>{insight.title}</h2>
                    </div>
                    {insight.severity === "critical" || insight.severity === "high" ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}
                  </div>
                  {insight.aiAnalysis ? (
                    <div className="insight-ai">
                      <div className="insight-ai-head">
                        <Sparkles size={14} />
                        <span>AI analysis</span>
                        <span className="pill blue">{Math.round(insight.aiAnalysis.confidence * 100)}% confident</span>
                        <span className="dim">{insight.aiAnalysis.model}</span>
                      </div>
                      <p className="insight-ai-summary">{insight.aiAnalysis.summary}</p>
                      <div className="insight-ai-grid">
                        <div>
                          <span className="w-caption">Likely cause</span>
                          <p>{insight.aiAnalysis.rootCause}</p>
                        </div>
                        <div>
                          <span className="w-caption">Recommended action</span>
                          <p>{insight.aiAnalysis.recommendedAction}</p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="insight-ai-pending dim">AI analysis pending — it appears after the next scan.</p>
                  )}
                  <details className="insight-detector">
                    <summary>Detector signal</summary>
                    <p>{insight.plainSummary}</p>
                  </details>
                  <EvidenceDrawer evidenceRefs={insight.evidenceRefs} />
                  <div className="insight-reason-row">
                    <input
                      value={reasons[insight.id] ?? ""}
                      onChange={(event) => setReasons((current) => ({ ...current, [insight.id]: event.target.value }))}
                      placeholder="Reason for applying or dismissing"
                      aria-label={`Reason for ${insight.title}`}
                    />
                  </div>
                  <div className="insight-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={!insight.actionDescriptorId || busyId === insight.id}
                      onClick={() => applyInsight(insight)}
                      title={insight.actionDescriptorId ? "Apply this audited action" : "Open the manual page for this insight"}
                    >
                      <CheckCircle2 size={14} />
                      Apply
                    </button>
                    <Link href={insight.manualPageHref} className="btn btn-ghost">
                      <ExternalLink size={14} />
                      Configure manually
                    </Link>
                    <button type="button" className="btn btn-ghost" disabled={busyId === insight.id} onClick={() => dismissInsight(insight)}>
                      <XCircle size={14} />
                      Dismiss
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busyId === `ai:${insight.id}`}
                      onClick={() => reanalyze(insight)}
                      title="Ask the AI to re-analyse this finding now"
                    >
                      <Sparkles size={14} />
                      {busyId === `ai:${insight.id}` ? "Analysing…" : "Re-analyze"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
