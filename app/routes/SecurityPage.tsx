import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, KeyRound, RefreshCw, Shield, ShieldCheck, XCircle } from "lucide-react";
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

type SecuritySecretExposureFinding = {
  id: string;
  sourceKey: string;
  title: string;
  severity: Insight["severity"];
  status: Insight["status"];
  href: string;
};

type SecuritySecret = {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  ageDays: number;
  rotationRecommended: boolean;
  exposureFindingCount: number;
  exposureFindings: SecuritySecretExposureFinding[];
};

type SecuritySecretsPayload = {
  rotationRecommendedAfterDays: number;
  secrets: SecuritySecret[];
};

function severityClass(severity: Insight["severity"]): string {
  if (severity === "critical" || severity === "high") return "red";
  if (severity === "medium") return "amber";
  if (severity === "low") return "blue";
  return "gray";
}

function formatTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "Unknown";
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSecretAge(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
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
                aria-label={`Reason for ${check.name}`}
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

function SecuritySecretsSection({
  data,
  loading,
  error,
  refresh,
}: {
  data: SecuritySecretsPayload | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}) {
  const secretsNeedingRotation = data?.secrets.filter((secret) => secret.rotationRecommended).length ?? 0;

  return (
    <section id="secrets" className="dash-section security-secrets-section">
      <div className="security-section-head">
        <div>
          <div className="dash-section-title">secrets</div>
          <h2>Secrets lifecycle</h2>
          <p>
            Inventory is metadata-only. Secret values, encryption material, IVs, and key identifiers are never returned to this page.
          </p>
        </div>
        <div className="security-section-actions">
          {data && (
            <span className={`pill ${secretsNeedingRotation > 0 ? "amber" : "green"}`}>
              {secretsNeedingRotation} rotation recommended
            </span>
          )}
          <button type="button" className="btn btn-ghost" onClick={refresh} disabled={loading}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {loading && !data && <div className="loading-panel">Loading secrets inventory.</div>}

      {error && !data && (
        <div className="loading-panel error">
          <p>The secrets inventory did not load. {error}</p>
          <button type="button" className="btn" onClick={refresh}>Retry</button>
        </div>
      )}

      {data && data.secrets.length === 0 && (
        <div className="empty-state">
          <KeyRound size={18} />
          <strong>No secrets registered yet.</strong>
        </div>
      )}

      {data && data.secrets.length > 0 && (
        <div className="table-wrap security-secrets-table-wrap">
          <table className="data-table security-secrets-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Age</th>
                <th>Last rotated</th>
                <th>Exposure findings</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.secrets.map((secret) => (
                <tr key={secret.id}>
                  <td className="mono">{secret.name}</td>
                  <td className="dim">{secret.description || "No description"}</td>
                  <td>
                    <div className="security-secret-age">
                      <span>{formatSecretAge(secret.ageDays)}</span>
                      {secret.rotationRecommended && (
                        <span className="pill amber">Rotation recommended</span>
                      )}
                    </div>
                  </td>
                  <td className="dim">{formatTimestamp(secret.updatedAt)}</td>
                  <td>
                    {secret.exposureFindingCount === 0 ? (
                      <span className="pill green">No exposure signal</span>
                    ) : (
                      <div className="security-exposure-links">
                        {secret.exposureFindings.map((finding) => (
                          <Link key={finding.id} href={finding.href} className={`pill ${severityClass(finding.severity)}`}>
                            {finding.title}
                          </Link>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <Link href="/governance" className="btn btn-ghost btn-sm">
                      <ExternalLink size={13} />
                      Rotate
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SecurityVulnerabilitiesSection() {
  return (
    <section id="vulnerabilities" className="dash-section security-not-configured-section">
      <div className="security-section-head">
        <div>
          <div className="dash-section-title">vulnerabilities</div>
          <h2>Vulnerability scanners</h2>
          <p>
            No vulnerability/CVE scanner is connected. When a scanner, such as SCA or SAST, is configured, findings appear here.
          </p>
        </div>
      </div>
      <div className="security-not-configured-grid">
        <div className="security-not-configured-panel">
          <span className="pill gray">Not configured</span>
          <h3>Application and dependency scanning</h3>
          <p>SAST, DAST, SCA, container image, and dependency scanners are not connected to this control surface.</p>
        </div>
        <div className="security-not-configured-panel">
          <span className="pill gray">Not configured</span>
          <h3>Cloud posture scanning</h3>
          <p>CSPM/cloud-posture scanning is not configured for this single-host deployment.</p>
        </div>
      </div>
    </section>
  );
}

export function SecurityPage() {
  const { data, loading, error, refresh } = useApi<SecurityPosturePayload>(`/api/security/posture`, 5_000);
  const { data: trustData, loading: trustLoading, error: trustError, refresh: refreshTrust } = useApi<TrustScorePayload>(`/api/security/trust-score`, 10_000);
  const { data: secretsData, loading: secretsLoading, error: secretsError, refresh: refreshSecrets } = useApi<SecuritySecretsPayload>(`/api/security/secrets`, 15_000);
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
  const secretsNeedingRotation = secretsData?.secrets.filter((secret) => secret.rotationRecommended).length ?? 0;

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
            Real summary: posture is {posture.replace("-", " ")}, {openCount} open security finding{openCount === 1 ? "" : "s"}, and {secretsNeedingRotation} secret{secretsNeedingRotation === 1 ? "" : "s"} need rotation.
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
            <KeyRound size={18} />
            <span>{secretsNeedingRotation}</span>
            <small>rotate</small>
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

      <nav className="security-section-nav" aria-label="Security Center sections">
        <a href="#posture">Posture</a>
        <a href="#findings">Findings</a>
        <a href="#secrets">Secrets</a>
        <a href="#vulnerabilities">Vulnerabilities</a>
      </nav>

      <section id="posture" className="dash-section trust-score-section">
        <div className="security-section-head">
          <div>
            <div className="dash-section-title">posture</div>
            <h2>Trust score and posture drivers</h2>
            <p>The trust dial, history, and improvement actions are computed from the existing security score engine.</p>
          </div>
        </div>

        {trustLoading && !trustData && <div className="loading-panel">Loading trust score...</div>}
        {trustError && !trustData && (
          <div className="loading-panel error">
            <p>The trust score did not load. {trustError}</p>
            <button type="button" className="btn" onClick={refreshTrust}>Retry</button>
          </div>
        )}

        {trustData && (
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
        )}
      </section>

      {(() => {
        const openFindings = findings.filter((f) => f.status === "open");
        const closedFindings = findings.filter((f) => f.status !== "open");
        const renderFinding = (insight: (typeof findings)[number]) => (
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
        );
        return (
          <>
            {openFindings.length === 0 ? (
              <section id="findings" className="dash-section">
                <div className="security-section-head">
                  <div>
                    <div className="dash-section-title">findings</div>
                    <h2>Security findings</h2>
                    <p>These are the current security-domain insights produced by the real detector catalog.</p>
                  </div>
                </div>
                <div className="empty-state">
                  <ShieldCheck size={24} />
                  <strong>All {checksRun} security checks passed. Nothing needs your attention.</strong>
                </div>
              </section>
            ) : (
              <section id="findings" className="dash-section">
                <div className="security-section-head">
                  <div>
                    <div className="dash-section-title">findings</div>
                    <h2>Security findings</h2>
                    <p>These are the current security-domain insights produced by the real detector catalog.</p>
                  </div>
                </div>
                <div className="insight-card-list">{openFindings.map(renderFinding)}</div>
              </section>
            )}
            {closedFindings.length > 0 && (
              <section className="dash-section">
                <details className="earned-checks-details">
                  <summary>Resolved findings ({closedFindings.length})</summary>
                  <div className="insight-card-list">{closedFindings.map(renderFinding)}</div>
                </details>
              </section>
            )}
          </>
        );
      })()}

      <SecuritySecretsSection
        data={secretsData}
        loading={secretsLoading}
        error={secretsError}
        refresh={refreshSecrets}
      />

      <SecurityVulnerabilitiesSection />
    </div>
  );
}
