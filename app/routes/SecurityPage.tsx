import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, RefreshCw, Shield, ShieldCheck, XCircle } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";
import type { ApiEnvelope, EvidenceRef } from "../../server/api/types";
import type { Insight } from "../../server/insights/types";

type TrustCheck = {
  id: string;
  name: string;
  points: number;
  earned: boolean;
  plainSummary: string;
  actionDescriptorId?: string;
  manualPageHref?: string;
};

type TrustScorePayload = {
  score: number;
  maxScore: number;
  checks: TrustCheck[];
  improvementActions: TrustCheck[];
  computedAt: number;
  history: { ts: number; score: number }[];
};

type SecurityPosturePayload = {
  posture: "good" | "needs-attention" | "at-risk";
  openCount: number;
  resolvedCount: number;
  lastScanAt: number;
  checksRun: number;
  findings: Insight[];
};

function severityClass(severity: Insight["severity"]): string {
  if (severity === "critical" || severity === "high") return "red";
  if (severity === "medium") return "amber";
  if (severity === "low") return "blue";
  return "gray";
}

function TrustScoreDial({ score, maxScore }: { score: number; maxScore: number }) {
  const percent = Math.min(100, Math.max(0, (score / maxScore) * 100));
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;
  
  let color = "var(--red)";
  if (percent >= 80) color = "var(--green)";
  else if (percent >= 50) color = "var(--amber-warn)";

  return (
    <div className="trust-dial">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={radius} fill="transparent" stroke="var(--bg-raised)" strokeWidth="8" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="transparent"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
        <text x="50" y="50" textAnchor="middle" dominantBaseline="central">
          <tspan x="50" dy="-0.1em" fontSize="20" fontWeight="bold" fill="var(--text-bright)">{score}</tspan>
          <tspan x="50" dy="1.4em" fontSize="8" fill="var(--text-dim)">/ {maxScore}</tspan>
        </text>
      </svg>
    </div>
  );
}

function TrustScoreHistory({ history }: { history: TrustScorePayload["history"] }) {
  if (!history || history.length < 2) {
    return <div className="trust-history-empty">Score history starts today.</div>;
  }

  const width = 100;
  const height = 30;
  const minScore = 0;
  const maxScore = 100;
  const sorted = [...history].sort((a, b) => a.ts - b.ts);
  
  const points = sorted.map((h, i) => {
    const x = (i / (sorted.length - 1)) * width;
    const y = height - ((h.score - minScore) / (maxScore - minScore)) * height;
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="trust-history">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <polyline
          fill="none"
          stroke="var(--blue)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={points}
        />
      </svg>
      <div className="trust-history-label">Score history (30d)</div>
    </div>
  );
}

function TrustCheckRow({ 
  check, 
  onApply, 
  isBusy, 
  reason, 
  setReason 
}: { 
  check: TrustCheck; 
  onApply: (c: TrustCheck) => void; 
  isBusy: boolean;
  reason: string;
  setReason: (r: string) => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <div className="trust-check-row">
      <div className="trust-check-info">
        <div className="trust-check-header">
          <span className="pill blue">+{check.points} points</span>
          <strong>{check.name}</strong>
        </div>
        <p>{check.plainSummary}</p>
      </div>
      <div className="trust-check-actions">
        {check.actionDescriptorId ? (
          showConfirm ? (
            <div className="trust-check-confirm">
              <input 
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason..."
                autoFocus
                className="insight-reason-input"
              />
              <button 
                type="button"
                className="btn" 
                onClick={() => onApply(check)}
                disabled={isBusy}
              >
                Confirm
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowConfirm(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setShowConfirm(true)} disabled={isBusy}>
              Apply
            </button>
          )
        ) : (
          <Link href={check.manualPageHref || "#"} className="btn btn-ghost">
            <ExternalLink size={14} />
            Open the manual page
          </Link>
        )}
      </div>
    </div>
  );
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

export function SecurityPage() {
  const { data, loading, error, refresh } = useApi<SecurityPosturePayload>(`/api/security/posture`, 5_000);
  const { data: trustData, loading: trustLoading, error: trustError, refresh: refreshTrust } = useApi<TrustScorePayload>(`/api/security/trust-score`, 10_000);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

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
      setMessage(result.data?.message ?? "The security finding was applied and recorded.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The finding could not be applied.");
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
      setMessage(result.data?.message ?? "The security finding was dismissed.");
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The finding could not be dismissed.");
    } finally {
      setBusyId(null);
    }
  }

  async function applyImprovement(check: TrustCheck) {
    setBusyId(check.id);
    setMessage(null);
    try {
      const reason = (reasons[check.id] ?? "").trim();
      const result = await post(`/api/actions/execute`, {
        actionId: check.actionDescriptorId,
        reason,
        confirmed: true,
        params: {},
      });
      setMessage(result.data?.message ?? `Improvement applied: ${check.name}`);
      refreshTrust();
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The improvement could not be applied.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading && !data) return <div className="loading-panel">Loading security posture.</div>;
  if (error && !data) return (
    <div className="loading-panel error">
      <p>The security posture did not load. {error}</p>
      <button type="button" className="btn" onClick={refresh}>Retry</button>
    </div>
  );

  const { posture, openCount, resolvedCount, lastScanAt, checksRun, findings } = data!;

  const postureText = posture === "good" 
    ? "Your security posture is good — no open findings."
    : `${openCount} finding${openCount === 1 ? "" : "s"} need${openCount === 1 ? "s" : ""} your attention.`;

  return (
    <div className="dash-page security-page">
      <section className="insights-hero">
        <div>
          <div className="dash-section-title">security posture</div>
          <h1>{postureText}</h1>
          <p>
            This admin center monitors for credential leaks, owner sprawl, and agent budget caps across your tenant.
          </p>
        </div>
        <div className="insights-hero-actions">
           <div className="insights-count">
            <Shield size={18} />
            <span>{openCount}</span>
            <small>open</small>
          </div>
          <div className="insights-count">
            <CheckCircle2 size={18} />
            <span>{resolvedCount}</span>
            <small>resolved</small>
          </div>
          <div className="insights-count">
            <ShieldCheck size={18} />
            <span>{checksRun}</span>
            <small>checks run</small>
          </div>
          <div className="insights-count">
            <RefreshCw size={18} />
            <span>
              {new Date(lastScanAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
            <small>last scan</small>
          </div>
        </div>
      </section>

      {message && <div className="insights-message"><CheckCircle2 size={15} />{message}</div>}

      {trustLoading && !trustData && <div className="dash-section loading-panel">Loading trust score...</div>}
      
      {trustData && (
        <section className="dash-section trust-score-section">
          <div className="trust-score-grid">
            <div className="trust-score-hero-card">
              <TrustScoreDial score={trustData.score} maxScore={trustData.maxScore} />
              <div className="trust-score-details">
                <div className="dash-section-title">trust score</div>
                <p className="trust-interpretation">
                  {`Your workspace earns ${trustData.score} of ${trustData.maxScore} trust points. ${trustData.improvementActions.length} improvement${trustData.improvementActions.length === 1 ? "" : "s"} would take you to ${trustData.maxScore}.`}
                </p>
                <TrustScoreHistory history={trustData.history} />
              </div>
            </div>
            
            <div className="trust-improvements">
              <div className="dash-section-title">improvement actions</div>
              {trustData.improvementActions.length === 0 ? (
                <div className="empty-state">
                  <ShieldCheck size={18} />
                  <span>Your trust score is maximized. No improvements available.</span>
                </div>
              ) : (
                <div className="trust-check-list">
                  {trustData.improvementActions.map((check) => (
                    <TrustCheckRow
                      key={check.id}
                      check={check}
                      onApply={applyImprovement}
                      isBusy={busyId === check.id}
                      reason={reasons[check.id] ?? ""}
                      setReason={(r) => setReasons((curr) => ({ ...curr, [check.id]: r }))}
                    />
                  ))}
                </div>
              )}

              {trustData.checks.some(c => c.earned) && (
                <details className="earned-checks-details">
                  <summary>Earned checks ({trustData.checks.filter(c => c.earned).length})</summary>
                  <div className="earned-checks-list">
                    {trustData.checks.filter(c => c.earned).map(c => (
                      <div key={c.id} className="earned-check-item">
                        <CheckCircle2 size={12} className="text-green" />
                        <span>{c.name}</span>
                        <span className="dim">({c.points} pts)</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </div>
        </section>
      )}

      {findings.length === 0 ? (
        <div className="dash-section">
          <div className="empty-state">
            <ShieldCheck size={24} />
            <strong>All {checksRun} security checks passed. Nothing needs your attention.</strong>
          </div>
        </div>
      ) : (
        <section className="dash-section">
          <div className="insight-card-list">
            {findings.map((insight) => (
              <article key={insight.id} className={`insight-card severity-${insight.severity}`}>
                <div className="insight-card-head">
                  <div>
                    <div className="insight-title-row">
                      <span className={`pill ${severityClass(insight.severity)}`}>{insight.severity}</span>
                      {insight.status === "resolved" && (
                        <span className="pill green">Resolved itself — verified by the scanner</span>
                      )}
                      {insight.status === "applied" && <span className="pill green">Applied</span>}
                      {insight.status === "dismissed" && <span className="pill gray">Dismissed</span>}
                    </div>
                    <h2>{insight.title}</h2>
                  </div>
                  {insight.severity === "critical" || insight.severity === "high" ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}
                </div>
                <p>{insight.plainSummary}</p>
                {insight.status === "resolved" && insight.resolution && (
                   <div className="insight-resolution">
                     <CheckCircle2 size={14} className="text-green-600" />
                     <span>{insight.resolution}</span>
                   </div>
                )}
                <EvidenceDrawer evidenceRefs={insight.evidenceRefs} />
                
                {insight.status === "open" && (
                  <>
                    <div className="insight-reason-row">
                      <input
                        value={reasons[insight.id] ?? ""}
                        onChange={(event) => setReasons((current) => ({ ...current, [insight.id]: event.target.value }))}
                        placeholder="Reason for applying or dismissing"
                        aria-label={`Reason for ${insight.title}`}
                      />
                    </div>
                    <div className="insight-actions">
                      {insight.actionDescriptorId ? (
                        <>
                          <button
                            type="button"
                            className="btn"
                            disabled={busyId === insight.id}
                            onClick={() => applyInsight(insight)}
                          >
                            <CheckCircle2 size={14} />
                            Apply
                          </button>
                          <button type="button" className="btn btn-ghost" disabled={busyId === insight.id} onClick={() => dismissInsight(insight)}>
                            <XCircle size={14} />
                            Dismiss
                          </button>
                        </>
                      ) : (
                        <Link href={insight.manualPageHref} className="btn btn-ghost">
                          <ExternalLink size={14} />
                          Open the manual page
                        </Link>
                      )}
                    </div>
                  </>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
