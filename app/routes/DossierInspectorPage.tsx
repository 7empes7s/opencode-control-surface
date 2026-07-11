import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";
import type { DossierArtifacts } from "../../server/api/types";
import { SourcesTable } from "../components/SourcesTable";
import { ClaimsTable } from "../components/ClaimsTable";
import { AgentRunList } from "../components/AgentRunList";
import { DossierInjectPanel } from "../components/DossierInjectPanel";

const PRE: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)",
  background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4,
  padding: "14px 16px", whiteSpace: "pre-wrap", lineHeight: 1.6,
  overflow: "auto", maxHeight: "70vh", margin: 0,
};

const PANEL: React.CSSProperties = {
  background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4,
};

const PANEL_HDR: React.CSSProperties = {
  padding: "7px 14px", borderBottom: "1px solid var(--border)",
  fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
  textTransform: "uppercase", letterSpacing: "0.08em",
};

const TABS = [
  { id: "header",     label: "Header" },
  { id: "sources",    label: "Sources" },
  { id: "claims",     label: "Claims" },
  { id: "draft",      label: "Draft" },
  { id: "verify",     label: "Verify" },
  { id: "agent-runs", label: "Agent Runs" },
  { id: "inject",     label: "Inject" },
];

const PIPELINE_STAGES = [
  "scout", "rank", "init", "research", "validate-research", "write",
  "validate-write", "verify", "publish-prep", "fetch-image", "auto-gate",
  "publish", "deploy", "notify",
] as const;

function tabStyle(active: boolean): React.CSSProperties {
  return {
    fontFamily: "var(--mono)", fontSize: 11, padding: "7px 16px",
    background: "none", border: "none", cursor: "pointer",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    color: active ? "var(--accent)" : "var(--text-dim)",
    letterSpacing: "0.02em", whiteSpace: "nowrap",
  };
}

function BriefRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.55 }}>{value}</div>
    </div>
  );
}

export function DossierInspectorPage() {
  const params: { date?: string; slug?: string } = useParams();
  const date = params.date ?? "";
  const slug = params.slug ?? "";
  const [, navigate] = useLocation();

  const { data, loading, error, refresh } = useApi<DossierArtifacts>(`/api/dossier/${date}/${slug}`);
  const [activeTab, setActiveTab] = useState("header");
  const [retryStage, setRetryStage] = useState<(typeof PIPELINE_STAGES)[number]>("research");
  const [retrying, setRetrying] = useState(false);
  const [retryFeedback, setRetryFeedback] = useState<{ message: string; error: boolean } | null>(null);

  if (loading && !data) return <div className="loading-dim">loading dossier…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;

  const handleInject = async (notes: string, stage: string | null, requeue: boolean) => {
    const res = await authFetch(`/api/dossier/${date}/${slug}/inject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes, stage, requeue }),
    });
    if (!res.ok) {
      const result = await res.json() as { error?: string };
      throw new Error(result.error ?? "Failed to inject notes");
    }
    refresh();
  };

  const handleStageRetry = async () => {
    const reason = window.prompt(`Reason for retrying ${slug} at ${retryStage}:`)?.trim();
    if (!reason) return;
    if (!window.confirm(`Retry ${date}/${slug} at pipeline stage ${retryStage}?`)) return;
    setRetrying(true);
    setRetryFeedback(null);
    try {
      const res = await authFetch("/api/actions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: `start-job:dossier:${date}/${slug}:inject:${retryStage}`,
          reason,
          confirmed: true,
        }),
      });
      const result = await res.json() as { message?: string; error?: string };
      if (!res.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
      setRetryFeedback({ message: result.message ?? `Stage ${retryStage} queued`, error: false });
    } catch (error) {
      setRetryFeedback({ message: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="dash-page">
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate("/autopipeline")}>← Pipeline</button>
          <div className="page-title" style={{ margin: 0 }}>Dossier</div>
          <span className="mono dim" style={{ fontSize: 11 }}>{date}</span>
        </div>
        {d.header.headline && (
          <div style={{ fontSize: 14, color: "var(--text-bright)", marginBottom: 4, lineHeight: 1.4 }}>{d.header.headline}</div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {d.header.vertical && <span className="pill gray">{d.header.vertical}</span>}
          {d.header.status && <span className="pill amber">{d.header.status}</span>}
          <button className="btn btn-ghost btn-sm" onClick={refresh}>Refresh</button>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)", marginBottom: 16, overflowX: "auto" }}>
        {TABS.map((t) => (
          <button key={t.id} style={tabStyle(activeTab === t.id)} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "header" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {/* Story Identity */}
          <div style={PANEL}>
            <div style={PANEL_HDR}>Story Identity</div>
            <table className="data-table">
              <tbody>
                {([
                  ["Slug",    d.header.slug,    true],
                  ["Owner",   d.header.owner,   false],
                  ["Created", d.header.created, true],
                  ["Updated", d.header.updated, true],
                  ["Status",  d.header.status,  false],
                ] as [string, string, boolean][]).map(([lbl, val, mono]) => (
                  <tr key={lbl}>
                    <td style={{ width: 72, color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 11, whiteSpace: "nowrap" }}>{lbl}</td>
                    <td style={{ fontFamily: mono ? "var(--mono)" : undefined, fontSize: mono ? 11 : 12, wordBreak: "break-all" }}>{val || <span className="dim">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Editorial Brief */}
          <div style={PANEL}>
            <div style={PANEL_HDR}>Editorial Brief</div>
            <div style={{ padding: "12px 14px" }}>
              <BriefRow label="Why now"            value={d.header["Why now"]} />
              <BriefRow label="Importance"         value={d.header["Public importance"]} />
              <BriefRow label="Core angle"         value={d.header["One-sentence framing"]} />
              <BriefRow label="Not about"          value={d.header["What the story is not"]} />
              <BriefRow label="Coverage reason"    value={d.header["Why NewsBites should cover it"]} />
            </div>
          </div>
        </div>
      )}

      {activeTab === "sources" && (
        <div style={PANEL}>
          <div style={PANEL_HDR}>Sources</div>
          <SourcesTable sources={d.sources} />
        </div>
      )}

      {activeTab === "claims" && (
        <div style={PANEL}>
          <div style={PANEL_HDR}>Claims</div>
          <ClaimsTable claims={d.claims} />
        </div>
      )}

      {activeTab === "draft" && (
        <pre style={PRE}>{d.draftContent || "No draft content yet."}</pre>
      )}

      {activeTab === "verify" && (
        d.verifyContent
          ? <pre style={PRE}>{d.verifyContent}</pre>
          : <div className="loading-dim">No verification content yet.</div>
      )}

      {activeTab === "agent-runs" && <AgentRunList agentRuns={d.agentRuns} />}

      {activeTab === "inject" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={PANEL}>
            <div style={PANEL_HDR}>Retry stage (governed)</div>
            <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <select
                value={retryStage}
                onChange={(event) => setRetryStage(event.target.value as typeof retryStage)}
                style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)", padding: "6px 9px", borderRadius: 3 }}
              >
                {PIPELINE_STAGES.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
              </select>
              <button className="btn btn-primary btn-sm" disabled={retrying} onClick={handleStageRetry}>
                {retrying ? "Queueing…" : "Retry stage"}
              </button>
              {retryFeedback && <span className={`action-feedback ${retryFeedback.error ? "err" : "ok"}`}>{retryFeedback.message}</span>}
            </div>
          </div>
          <DossierInjectPanel dossier={d} onInject={handleInject} />
        </div>
      )}
    </div>
  );
}
