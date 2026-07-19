import { useState } from "react";
import { ExternalLink, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { ConfirmModal } from "../components/ConfirmModal";
import { SectionCard } from "../components/SectionCard";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";
import type { KnowDetail } from "../../server/api/types";
import "./KnowPage.css";

type KnowAction = "refresh-health" | "refresh-ops" | "doctor" | "typecheck" | "build";

function Pill({ state, children }: { state: "good" | "warn" | "bad" | "muted"; children: React.ReactNode }) {
  const color = state === "good" ? "green" : state === "warn" ? "amber" : state === "bad" ? "red" : "gray";
  return <span className={`pill ${color}`}>{children}</span>;
}

function valueOrDash(value: unknown): React.ReactNode {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function timeAgo(seconds: number | null): string {
  if (seconds === null) return "unavailable";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function EmailDeliverySection({ email }: { email: KnowDetail["email"] }) {
  const [showTemplates, setShowTemplates] = useState(false);

  if (!email.available) {
    return (
      <SectionCard title="Email & delivery" right={<Pill state="muted">unavailable</Pill>}>
        <div className="section-card-body">
          <div className="know-callout">Email operations are unavailable — the Know ops snapshot did not include a sanitized email block. Refresh operations to populate it.</div>
        </div>
      </SectionCard>
    );
  }

  const t = email.templates;
  const s = email.storyDelivery;
  const transportLabel = email.transport === "microsoft365-oauth"
    ? "Microsoft 365 · OAuth2"
    : email.transport === "smtp-legacy" ? "SMTP · STARTTLS (legacy)" : "Not configured";
  const readinessPill = email.readiness === "ready" ? "good" : email.readiness === "partial" ? "warn" : "muted";

  const delivery: { pill: "good" | "warn" | "bad" | "muted"; label: string } = (() => {
    if (email.configured === false) return { pill: "warn", label: "Mail not configured" };
    if (s.last?.status === "failed") return { pill: "bad", label: "Last delivery failed" };
    if (s.optedIn === 0) return { pill: "muted", label: "Configured · no readers opted in" };
    if (s.optedIn !== null && s.optedIn > 0) return { pill: "good", label: `Configured · ${s.optedIn} opted in` };
    return { pill: "good", label: "Configured" };
  })();

  const coverageComplete = t.complete === true;

  return (
    <SectionCard
      title="Email & delivery"
      right={<Pill state={readinessPill}>{email.readiness ?? "unknown"}</Pill>}
    >
      <div className="section-card-body know-email">
        <div className="know-email-head">
          <div className="know-email-transport">
            <Mail size={15} />
            <div>
              <strong>{transportLabel}</strong>
              <span>Service email only · no identifiers or credentials shown</span>
            </div>
          </div>
          <Pill state={delivery.pill}>{delivery.label}</Pill>
        </div>

        <div className="know-kv compact know-email-kv">
          <div><span>Template scenarios</span><strong>{valueOrDash(t.total)}</strong></div>
          <div><span>HTML coverage</span><strong>{t.htmlCoverage !== null && t.total !== null ? `${t.htmlCoverage}/${t.total}` : "—"}</strong></div>
          <div><span>Plain-text coverage</span><strong>{t.textCoverage !== null && t.total !== null ? `${t.textCoverage}/${t.total}` : "—"}</strong></div>
          <div><span>Story-email preference</span><strong>{s.preferenceAvailable === true ? "available" : s.preferenceAvailable === false ? "unavailable" : "—"}</strong></div>
          <div><span>Readers opted in</span><strong>{valueOrDash(s.optedIn)}</strong></div>
          <div><span>Live stories eligible</span><strong>{valueOrDash(s.liveEligible)}</strong></div>
        </div>

        <div className="know-email-coverage">
          <button type="button" className="know-linkish" aria-expanded={showTemplates} onClick={() => setShowTemplates((v) => !v)}>
            {showTemplates ? "Hide" : "Show"} {t.total ?? 0} template scenarios
          </button>
          <Pill state={coverageComplete ? "good" : "warn"}>{coverageComplete ? "HTML + text complete" : "partial coverage"}</Pill>
        </div>
        {showTemplates && (
          <div className="know-chips" aria-label="Email template scenarios">
            {t.scenarios.length > 0
              ? t.scenarios.map((scenario) => <span key={scenario} className="know-chip">{scenario}</span>)
              : <span className="know-chip muted">no scenarios reported</span>}
          </div>
        )}

        <div className="know-email-delivery">
          <div className="know-email-delivery-head">
            <span>Story delivery outcomes</span>
            {s.deliveryLog === "present" && s.last?.at && <small>last {new Date(s.last.at).toLocaleString()}</small>}
          </div>
          {s.deliveryLog === "present" ? (
            <div className="know-delivery-totals">
              <span className="good">{s.totals.delivered ?? 0} delivered</span>
              <span className="warn">{s.totals.unavailable ?? 0} unavailable</span>
              <span className="bad">{s.totals.failed ?? 0} failed</span>
              {s.last?.status && <span className="muted">last: {s.last.status}</span>}
            </div>
          ) : (
            <div className="know-callout subtle">Outcome history is not aggregated yet — opt-in story emails are sent per request and default-off. Delivery totals appear here once Know records them.</div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

export function KnowPage() {
  const { data, loading, error, refresh } = useApi<KnowDetail>("/api/know", 30_000);
  const [running, setRunning] = useState<KnowAction | null>(null);
  const [buildModal, setBuildModal] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string; jobId?: string } | null>(null);

  const runAction = async (target: KnowAction, reason?: string) => {
    setRunning(target);
    setFeedback(null);
    try {
      const response = await authFetch("/api/actions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: `run:know:${target}`,
          ...(target === "build" ? { confirmed: true, reason } : {}),
        }),
      });
      const result = await response.json() as { error?: string; message?: string; jobId?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setFeedback({ ok: true, message: result.message ?? "Know action started", jobId: result.jobId });
      setTimeout(refresh, 3_000);
    } catch (actionError) {
      setFeedback({ ok: false, message: actionError instanceof Error ? actionError.message : String(actionError) });
    } finally {
      setRunning(null);
      setBuildModal(false);
    }
  };

  if (loading && !data) return <div className="loading-dim">loading Know…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;
  return (
    <div className="know-page">
      <div className="page-header know-header">
        <div>
          <div className="know-eyebrow">Independent learning product</div>
          <h1>Know</h1>
          <p>Health, operations, model routing and story workflow—without crossing into NewsBites state.</p>
        </div>
        <div className="know-header-actions">
          <button className="btn btn-ghost" onClick={refresh}><RefreshCw size={13} /> Refresh</button>
          {d.identity.publicUrl && <a className="btn btn-primary" href={d.identity.publicUrl} target="_blank" rel="noreferrer">Open Know <ExternalLink size={13} /></a>}
        </div>
      </div>

      <div className="know-hero-grid">
        <div className="know-score-card">
          <span>Product health</span>
          <strong>{valueOrDash(d.health.score)}<small>{d.health.score !== null ? "/100" : ""}</small></strong>
          <Pill state={d.health.ok === true ? "good" : d.health.ok === false ? "bad" : "muted"}>{d.health.ok === true ? "Healthy" : d.health.ok === false ? "Needs attention" : "Unknown"}</Pill>
        </div>
        <div className="know-metric"><span>Live stories</span><strong>{valueOrDash(d.operations.stories.live)}</strong><small>{d.operations.stories.drafts ?? 0} drafts</small></div>
        <div className="know-metric"><span>Checks</span><strong>{valueOrDash(d.health.total)}</strong><small>{d.health.failed ?? 0} failed</small></div>
        <div className="know-metric"><span>Runtime</span><strong>{d.runtime.reachable ? "Online" : "Offline"}</strong><small>HTTP {valueOrDash(d.runtime.status)}</small></div>
      </div>

      <div className="know-action-strip" aria-label="Safe Know actions">
        <div><strong>Safe checks</strong><span>Durable, audited, and bounded to Know.</span></div>
        {(["refresh-health", "refresh-ops", "doctor", "typecheck"] as KnowAction[]).map((target) => (
          <button key={target} className="btn btn-ghost btn-sm" disabled={running !== null} onClick={() => void runAction(target)}>
            {running === target ? "Starting…" : target.replace(/-/g, " ")}
          </button>
        ))}
        <button className="btn btn-ghost btn-sm" disabled={running !== null} onClick={() => setBuildModal(true)}>verify build</button>
      </div>
      {feedback && <div className={`know-feedback ${feedback.ok ? "ok" : "error"}`}>{feedback.message}{feedback.jobId && <> · <Link href="/jobs">job {feedback.jobId.slice(0, 8)}</Link></>}</div>}

      <div className="know-section-grid">
        <SectionCard title="Health" right={<Pill state={d.health.artifact.stale ? "warn" : d.health.artifact.state === "ok" ? "good" : "bad"}>{d.health.artifact.stale ? "stale" : d.health.artifact.state}</Pill>}>
          <div className="section-card-body know-kv">
            <div><span>Artifact</span><strong>{timeAgo(d.health.artifact.ageSeconds)}</strong></div>
            <div><span>Checked</span><strong>{d.health.checkedAt ? new Date(d.health.checkedAt).toLocaleString() : "—"}</strong></div>
            <div><span>Passed</span><strong>{d.health.total !== null ? d.health.total - (d.health.failed ?? 0) : "—"}</strong></div>
            <div><span>Failed</span><strong>{valueOrDash(d.health.failed)}</strong></div>
          </div>
        </SectionCard>

        <SectionCard title="Operations" right={<Pill state={d.operations.artifact.stale ? "warn" : d.operations.artifact.state === "ok" ? "good" : "bad"}>{d.operations.artifact.stale ? "stale" : d.operations.artifact.state}</Pill>}>
          <div className="section-card-body know-kv">
            <div><span>Database</span><strong>{d.operations.database.reachable ? `v${d.operations.database.schemaVersion}` : "unreachable"}</strong></div>
            <div><span>Accounts</span><strong>{valueOrDash(d.operations.database.accounts)}</strong></div>
            <div><span>Events</span><strong>{valueOrDash(d.operations.database.events)}</strong></div>
            <div><span>Story art</span><strong>{d.operations.stories.artComplete ? "complete" : "incomplete"}</strong></div>
            <div><span>Magic links</span><strong>{d.operations.capabilities.magicLink ? "configured" : "unavailable"}</strong></div>
            <div><span>Push</span><strong>{d.operations.capabilities.push ? "configured" : "unavailable"}</strong></div>
          </div>
        </SectionCard>
      </div>

      <EmailDeliverySection email={d.email} />

      <SectionCard title="Models" right={d.models.warning ? <Pill state="warn">degraded</Pill> : <Pill state="good">available</Pill>}>
        <div className="section-card-body">
          {d.models.warning && <div className="know-callout">{d.models.warning} Repair remains outside the Know product boundary.</div>}
          <div className="know-model-grid">
            {d.models.logicalModels.map((model) => (
              <div className="know-model" key={model.name}>
                <div><strong>{model.name}</strong><Pill state={model.available ? "good" : model.observed ? "warn" : "muted"}>{model.available ? "available" : model.observed ? "unavailable" : "not observed"}</Pill></div>
                <span>{valueOrDash(model.capability)} · {model.latencyMs !== null ? `${model.latencyMs}ms` : "no latency"}</span>
                <small>{Object.entries(d.models.configuredStageModels).filter(([, name]) => name === model.name).map(([stage]) => stage).join(", ") || "not assigned"}</small>
              </div>
            ))}
          </div>
        </div>
      </SectionCard>

      <div className="know-section-grid">
        <SectionCard title="Workflow">
          <div className="section-card-body">
            <div className="know-stage-line">{d.workflow.stages.map((stage, index) => <span key={stage}>{stage}{index < d.workflow.stages.length - 1 && <i>→</i>}</span>)}</div>
            <div className="know-kv compact">
              <div><span>Dossiers</span><strong>{valueOrDash(d.workflow.dossiers)}</strong></div>
              <div><span>Agent runs</span><strong>{valueOrDash(d.workflow.agentRuns)}</strong></div>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Doctor" right={<Pill state={d.doctor.ok ? (d.doctor.status === "degraded" ? "warn" : "good") : "bad"}>{d.doctor.status ?? "unknown"}</Pill>}>
          <div className="section-card-body">
            <div className="know-doctor-counts"><span>{d.doctor.counts.pass ?? 0} pass</span><span>{d.doctor.counts.warn ?? 0} warn</span><span>{d.doctor.counts.fail ?? 0} fail</span></div>
            <div className="know-findings">
              {d.doctor.findings.filter((finding) => finding.status !== "pass").map((finding) => <div key={finding.id}><Pill state={finding.status === "warn" ? "warn" : "bad"}>{finding.status}</Pill><span>{finding.summary}</span></div>)}
              {d.doctor.findings.every((finding) => finding.status === "pass") && <div><ShieldCheck size={14} /><span>No active doctor findings.</span></div>}
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Services & timers" defaultOpen={false}>
        <div className="section-card-body know-units">
          {[...d.units.services.map((unit) => ({ name: unit.name, status: unit.status, note: "service" })), ...d.units.timers.map((unit) => ({ name: unit.name, status: unit.active ? "active" : "inactive", note: unit.observeOnly ? "timer · observe only" : "timer" }))].map((unit) => (
            <div key={`${unit.note}-${unit.name}`}><span>{unit.name}</span><small>{unit.note}</small><Pill state={unit.status === "active" ? "good" : unit.status === "failed" ? "bad" : "warn"}>{unit.status}</Pill></div>
          ))}
        </div>
      </SectionCard>

      {buildModal && <ConfirmModal title="Verify Know production build" message="This creates a local production build for verification only. It does not deploy or restart Know." inputLabel="Reason" inputPlaceholder="Why are you running this verification?" confirmLabel="Start build" loading={running === "build"} onConfirm={(reason) => void runAction("build", reason)} onCancel={() => setBuildModal(false)} />}
    </div>
  );
}

