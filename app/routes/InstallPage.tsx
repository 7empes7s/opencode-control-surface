import { useState } from "react";
import { CheckCircle2, CircleAlert, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { useApi } from "../hooks/useApi";

type InstallCheckStatus = "pass" | "warn" | "fail";

type InstallSecretPresence = {
  id: string;
  label: string;
  present: boolean;
  source: "env" | "governance" | "absent";
};

type InstallStatusCheck = {
  id: string;
  label: string;
  status: InstallCheckStatus;
  source: string;
  howToFix: string;
  evidence: string;
};

type InstallStatusPayload = {
  generatedAt: number;
  allRequiredGreen: boolean;
  checks: InstallStatusCheck[];
  secrets: InstallSecretPresence[];
};

const STORAGE_KEY_DONE = "tib-install-wizard-done";

function statusPill(status: InstallCheckStatus) {
  if (status === "pass") return <span className="pill green">green</span>;
  if (status === "warn") return <span className="pill amber">warn</span>;
  return <span className="pill red">red</span>;
}

function statusIcon(status: InstallCheckStatus) {
  if (status === "pass") return <CheckCircle2 size={18} />;
  if (status === "warn") return <CircleAlert size={18} />;
  return <XCircle size={18} />;
}

export function InstallPage() {
  const { data, loading, error, refresh } = useApi<InstallStatusPayload>("/api/install/status", 15_000);
  const [done, setDone] = useState(() => localStorage.getItem(STORAGE_KEY_DONE) === "true");

  function markDone() {
    localStorage.setItem(STORAGE_KEY_DONE, "true");
    setDone(true);
  }

  const failing = data?.checks.filter((check) => check.status === "fail").length ?? 0;
  const warnings = data?.checks.filter((check) => check.status === "warn").length ?? 0;

  return (
    <div className="dash-page">
      <section className="insights-hero">
        <div>
          <div className="dash-section-title">advanced · setup</div>
          <h1>Install Readiness</h1>
          <p>Read-only setup checks for auth, secrets, tunnel reachability, sentinel health, and scheduler freshness.</p>
        </div>
        <div className="insights-hero-actions">
          <div className="insights-count">
            <ShieldCheck size={18} />
            <span>{failing}</span>
            <small>red</small>
          </div>
          <span className={`pill ${data?.allRequiredGreen ? "green" : "amber"}`}>
            {data?.allRequiredGreen ? "ready" : `${warnings} warn`}
          </span>
          <button type="button" className="btn" onClick={refresh} disabled={loading}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </section>

      {done && (
        <div className="insights-message" style={{ marginBottom: 12 }}>
          <CheckCircle2 size={15} />
          Setup link hidden from the sidebar on this browser.
        </div>
      )}

      {loading && !data && <div className="loading-panel">Loading install checks...</div>}
      {error && !data && <div className="loading-panel error">Install status did not load: {error}</div>}

      {data && (
        <>
          <section className="dash-section">
            <div className="dash-section-title">green-light checklist</div>
            <div className="insight-card-list">
              {data.checks.map((check) => (
                <article key={check.id} className={`insight-card severity-${check.status === "fail" ? "high" : check.status === "warn" ? "medium" : "info"}`}>
                  <div className="insight-card-head">
                    <div>
                      <div className="insight-title-row">
                        {statusPill(check.status)}
                        <span className="pill gray">{check.source}</span>
                      </div>
                      <h2>{check.label}</h2>
                    </div>
                    {statusIcon(check.status)}
                  </div>
                  <p className="dim" style={{ marginTop: 8 }}>{check.howToFix}</p>
                  <div className="insight-source-key">
                    <span className="dim" style={{ fontSize: 11 }}>evidence:</span>
                    <span className="pill gray" style={{ fontSize: 11 }}>{check.evidence}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="dash-section">
            <div className="dash-section-title">secret presence</div>
            <div className="insight-card-list">
              {data.secrets.map((secret) => (
                <article key={secret.id} className={`insight-card severity-${secret.present ? "info" : "medium"}`}>
                  <div className="insight-card-head">
                    <div>
                      <div className="insight-title-row">
                        <span className={`pill ${secret.present ? "green" : "red"}`}>{secret.present ? "present" : "missing"}</span>
                        <span className="pill gray">{secret.source}</span>
                      </div>
                      <h2>{secret.label}</h2>
                    </div>
                    {secret.present ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="dash-section">
            <div className="dash-section-title">finish</div>
            <div className="insights-filter-bar" style={{ justifyContent: "space-between" }}>
              <span className="dim" style={{ fontSize: 12 }}>
                Last checked {new Date(data.generatedAt).toLocaleString()}
              </span>
              <button type="button" className="btn btn-primary" onClick={markDone} style={{ minHeight: 44 }}>
                <CheckCircle2 size={14} />
                Done
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
