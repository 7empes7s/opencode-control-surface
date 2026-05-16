import { useState } from "react";
import { useApi, fmtAge } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { ConfirmModal } from "../components/ConfirmModal";
import { SectionCard } from "../components/SectionCard";
import { RatingsSection } from "./RatingsPage";
import type { ModelsDetail } from "../../server/api/types";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function qualityColor(s: string): string {
  if (s === "healthy") return "green";
  if (s === "blocked") return "red";
  if (s === "degraded" || s === "probation") return "amber";
  return "gray";
}

function fmtContextWindow(ctx: number | null): string {
  if (!ctx) return "—";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`;
  if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
  return String(ctx);
}

type Modal =
  | { type: "block"; model: string }
  | { type: "unblock"; model: string }
  | { type: "probation-clear"; model: string }
  | { type: "run-check" };

export function ModelsPage() {
  const { data, loading, error, refresh } = useApi<ModelsDetail>("/api/models", 30_000);
  const [modal, setModal] = useState<Modal | null>(null);
  const action = useAction("/api/models/action");

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;
  const s = d.summary;

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Models</div>
        <div className="stat-row">
          <div className="stat-item">
            <div className="stat-lbl">best heavy</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--accent)", marginTop: 2 }}>{s.bestCloudHeavy ?? "—"}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">best fast</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", marginTop: 2 }}>{s.bestCloudFast ?? "—"}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">best local</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", marginTop: 2 }}>{s.bestLocal ?? "—"}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">full check</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>{fmtAge(s.lastFullCheckAgo)}</div>
          </div>
          <div className="stat-item">
            <div className="stat-lbl">quick check</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>{fmtAge(s.lastQuickCheckAgo)}</div>
          </div>
        </div>
      </div>

      {modal && (
        <ConfirmModal
          title={
            modal.type === "block" ? `Block ${modal.model}?` :
            modal.type === "unblock" ? `Unblock ${modal.model}?` :
            modal.type === "probation-clear" ? `Clear probation for ${modal.model}?` :
            "Run model health check?"
          }
          message={
            modal.type === "block"
              ? `${modal.model} will be marked blocked and excluded from fallback chains.`
              : modal.type === "unblock"
              ? `${modal.model} will be restored to healthy status.`
              : modal.type === "probation-clear"
              ? `${modal.model} will be cleared from probation and restored to healthy status.`
              : "Triggers the model-health-check.service immediately."
          }
          confirmLabel={
            modal.type === "block" ? "Block" :
            modal.type === "unblock" ? "Unblock" :
            modal.type === "probation-clear" ? "Clear" :
            "Run"
          }
          danger={modal.type === "block"}
          loading={action.loading}
          error={action.error}
          onCancel={() => { setModal(null); action.reset(); }}
          onConfirm={async () => {
            let body: unknown;
            if (modal.type === "block") body = { action: "block", model: modal.model };
            else if (modal.type === "unblock") body = { action: "unblock", model: modal.model };
            else if (modal.type === "probation-clear") body = { action: "probation-clear", model: modal.model };
            else body = { action: "run-quick-check" };
            const ok = await action.run(body);
            if (ok) { setModal(null); refresh(); }
          }}
        />
      )}

      {/* Quality summary */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <Pill color="blue">heavy {s.availableByCapability.heavy}</Pill>
        <Pill color="gray">medium {s.availableByCapability.medium}</Pill>
        <Pill color="gray">light {s.availableByCapability.light}</Pill>
        {s.qualitySummary.blocked > 0 && <Pill color="red">blocked {s.qualitySummary.blocked}</Pill>}
        {s.qualitySummary.degraded > 0 && <Pill color="amber">degraded {s.qualitySummary.degraded}</Pill>}
        {s.qualitySummary.probation > 0 && <Pill color="amber">probation {s.qualitySummary.probation}</Pill>}
        {s.newModelsAdded.length > 0 && <Pill color="green">+{s.newModelsAdded.length} new</Pill>}
      </div>

      <div className="action-bar" style={{ marginBottom: 16 }}>
        <button className="btn btn-ghost" onClick={() => setModal({ type: "run-check" })}>
          Run health check
        </button>
        {action.success && <span className="action-feedback ok">{action.success}</span>}
        {action.error && <span className="action-feedback err">{action.error}</span>}
      </div>

      {/* All models table */}
      <SectionCard
        title="all models"
        id="current"
        defaultOpen={true}
        right={<span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{d.models.length} total</span>}
      >
        <div className="section-card-body table-wrap">
          <table className="data-table models-table">
            <colgroup>
              <col className="name-col" />
              <col className="cap-col" />
              <col className="quality-col" />
              <col className="actions-col" />
              <col className="price-col" />
              <col className="type-col" />
              <col className="cli-col" />
              <col className="provider-col" />
              <col className="ctx-col" />
              <col className="rating-col" />
              <col className="latency-col" />
              <col className="json-col" />
              <col className="fails-col" />
            </colgroup>
            <thead><tr>
              <th>logical name</th><th>cap</th><th>quality</th><th></th>
              <th className="price-col">pricing</th><th className="type-col">type</th><th className="cli-col">CLI</th>
              <th className="models-col-provider provider-col">provider</th>
              <th className="ctx-col">ctx</th><th className="rating-col">rating</th><th className="latency-col models-col-latency">latency</th><th className="models-col-json">json</th><th className="models-col-failures">fails</th>
            </tr></thead>
            <tbody>
              {d.models.map((m) => (
                <tr key={m.logicalName}>
                  <td className="mono" style={{ color: m.available ? "var(--text-bright)" : "var(--text-dim)" }}>{m.logicalName}</td>
                  <td><Pill color={m.capability === "heavy" ? "blue" : "gray"}>{m.capability}</Pill></td>
                  <td><Pill color={qualityColor(m.qualityStatus)}>{m.qualityStatus}</Pill></td>
                  <td className="actions-col">
                    <div style={{ display: "flex", gap: 4 }}>
                      {m.qualityStatus === "blocked" ? (
                        <button className="btn btn-sm btn-primary" onClick={() => setModal({ type: "unblock", model: m.logicalName })}>unblock</button>
                      ) : m.qualityStatus === "probation" ? (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => setModal({ type: "probation-clear", model: m.logicalName })}>clear</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setModal({ type: "block", model: m.logicalName })}>block</button>
                        </>
                      ) : (
                        <button className="btn btn-sm btn-danger" onClick={() => setModal({ type: "block", model: m.logicalName })}>block</button>
                      )}
                    </div>
                  </td>
                  <td className="price-col">
                    {m.isFree && <Pill color="green">free</Pill>}
                    {m.isPaid && !m.isFree && <Pill color="amber">paid</Pill>}
                    {m.isOpenCode && <span className="text-xs" style={{ marginLeft: 4 }} title="OpenCode native">🔷</span>}
                  </td>
                  <td className="type-col"><Pill>{m.providerType}</Pill></td>
                  <td className="cli-col">{m.isCli ? <Pill color="blue">CLI</Pill> : "—"}</td>
                  <td className="dim mono models-col-provider provider-col">{m.provider}</td>
                  <td className="mono dim ctx-col">{fmtContextWindow(m.contextWindow)}</td>
                  <td className="mono dim rating-col">{(m as any).rating ? (m as any).rating.toFixed(1) : "—"}</td>
                  <td className="mono dim latency-col models-col-latency">{m.latency != null ? `${m.latency}ms` : "—"}</td>
                  <td className="models-col-json"><Pill color={m.jsonOk ? "green" : "red"}>{m.jsonOk ? "✓" : "✗"}</Pill></td>
                  <td className="mono dim models-col-failures">
                    {m.recentFailures > 0 ? <span className="text-red">{m.recentFailures}</span> : "0"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Fallback chains */}
      <SectionCard title="fallback chains" defaultOpen={false}>
        <div className="section-card-body" style={{ padding: "12px 14px" }}>
          <div className="chain-list">
            {Object.entries(d.fallbacks).map(([chain, models]) => (
              <div key={chain} className="chain-item">
                <div className="chain-name">{chain}</div>
                <div className="chain-models">
                  {models.map((m, i) => (
                    <span key={m} className={`chain-model ${i === 0 ? "first" : ""}`}>{i + 1}. {m}</span>
                  ))}
                </div>
              </div>
            ))}
            {Object.keys(d.fallbacks).length === 0 && <div className="loading-dim">no fallback chains in health file</div>}
          </div>
        </div>
      </SectionCard>

      {/* Cooldowns */}
      <SectionCard
        title="active cooldowns"
        id="cooldowns"
        defaultOpen={false}
        right={<span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{d.cooldowns.length}</span>}
      >
        <div className="section-card-body table-wrap">
          {d.cooldowns.length === 0 ? (
            <div className="loading-dim">no active cooldowns</div>
          ) : (
            <table className="data-table">
              <thead><tr><th>model</th><th>expires</th><th>reason</th></tr></thead>
              <tbody>
                {d.cooldowns.map((c) => (
                  <tr key={c.model}>
                    <td className="mono">{c.model}</td>
                    <td className="mono dim">{new Date(c.expiresAt).toISOString().slice(0, 19).replace("T", " ")} UTC</td>
                    <td className="dim">{c.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </SectionCard>

      {/* Discovery log */}
      <SectionCard title="discovery log" id="new" defaultOpen={false}>
        <div className="section-card-body table-wrap">
          {d.discoveryLog.length === 0 ? (
            <div className="loading-dim">discovery log not yet created — will appear after next full model-health-check run</div>
          ) : (
            <table className="data-table">
              <thead><tr><th>time</th><th>new models</th><th>total</th></tr></thead>
              <tbody>
                {[...d.discoveryLog].reverse().map((entry, i) => (
                  <tr key={i}>
                    <td className="mono dim">{entry.ts.slice(0, 19).replace("T", " ")}</td>
                    <td>
                      {entry.newModelsAdded.length > 0
                        ? entry.newModelsAdded.map((m) => <span key={m} className="chain-model" style={{ marginRight: 4 }}>{m}</span>)
                        : <span className="dim">none</span>}
                    </td>
                    <td className="mono dim">{entry.totalModelCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </SectionCard>

      <RatingsSection models={d.models} />
    </div>
  );
}
