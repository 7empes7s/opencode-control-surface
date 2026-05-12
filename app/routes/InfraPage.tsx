import { useState } from "react";
import { useApi, fmtAge } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { ConfirmModal } from "../components/ConfirmModal";
import { SectionCard } from "../components/SectionCard";
import type { InfraDetail } from "../../server/api/types";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function PctBar({ pct, warn = 80, crit = 95 }: { pct: number; warn?: number; crit?: number }) {
  const color = pct >= crit ? "var(--red)" : pct >= warn ? "var(--amber)" : "var(--accent)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color, minWidth: 32 }}>{pct}%</span>
    </div>
  );
}

type Modal =
  | { type: "service-restart"; service: string }
  | { type: "run-timer"; timer: string };

export function InfraPage() {
  const { data, loading, error, refresh } = useApi<InfraDetail>("/api/infra", 30_000);
  const [modal, setModal] = useState<Modal | null>(null);
  const svcAction = useAction("/api/infra/service-restart");
  const timerAction = useAction("/api/infra/run-timer");

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;
  const h = d.hetzner;
  const memGb = h.memTotalKb > 0 ? (h.memTotalKb / 1024 / 1024).toFixed(1) : "?";
  const memUsedGb = (h.memUsedKb / 1024 / 1024).toFixed(1);

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Infrastructure</div>
      </div>

      {modal && (
        <ConfirmModal
          title={
            modal.type === "service-restart" ? `Restart ${modal.service}?` : `Run ${modal.timer} now?`
          }
          message={
            modal.type === "service-restart"
              ? `This will restart the ${modal.service} service. Brief downtime expected.`
              : `This will immediately trigger the ${modal.timer} timer service.`
          }
          confirmLabel={modal.type === "service-restart" ? "Restart" : "Run now"}
          danger={modal.type === "service-restart"}
          loading={svcAction.loading || timerAction.loading}
          error={svcAction.error ?? timerAction.error}
          onCancel={() => { setModal(null); svcAction.reset(); timerAction.reset(); }}
          onConfirm={async () => {
            let ok = false;
            if (modal.type === "service-restart") {
              ok = await svcAction.run({ service: modal.service });
            } else {
              ok = await timerAction.run({ timer: modal.timer });
            }
            if (ok) { setModal(null); refresh(); }
          }}
        />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginBottom: 16 }}>

        {/* Hetzner */}
        <SectionCard title="hetzner CX32" id="hetzner" defaultOpen={true}>
          <div className="section-card-body" style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <div className="w-label">memory ({memUsedGb} / {memGb} GB)</div>
                <PctBar pct={h.memUsedPct} />
              </div>
              <div>
                <div className="w-label">disk ({h.diskUsedGb} / {h.diskTotalGb} GB)</div>
                <PctBar pct={h.diskUsedPct} />
              </div>
              <div>
                <div className="w-label">load avg</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)" }}>
                  {h.load1.toFixed(2)} · {h.load5.toFixed(2)} · {h.load15.toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* GPU / vast */}
        <SectionCard title="gpu tunnel" id="gpu" defaultOpen={true}>
          <div className="section-card-body" style={{ padding: "12px 14px" }}>
            <div className="w-row" style={{ marginBottom: 8 }}>
              <Pill color={d.gpu.status === "up" ? "green" : d.gpu.status === "down" ? "red" : "amber"}>{d.gpu.status}</Pill>
              {d.gpu.gpuUtil !== null && <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{d.gpu.gpuUtil}% util</span>}
            </div>
            {d.gpu.loadedModels.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                {d.gpu.loadedModels.map((m) => <span key={m} className="chain-model">{m}</span>)}
              </div>
            )}
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
              checked {d.gpu.checkedAgo >= 0 ? fmtAge(d.gpu.checkedAgo) : "—"}
            </div>
          </div>
        </SectionCard>

        {/* Vast instance */}
        <SectionCard title="vast.ai instance" id="vast" defaultOpen={true}>
          <div className="section-card-body" style={{ padding: "12px 14px" }}>
            {d.vastInstance ? (
              <div>
                <div className="w-row" style={{ marginBottom: 6 }}>
                  <Pill color={d.vastInstance.status === "running" ? "green" : "amber"}>{d.vastInstance.status}</Pill>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)" }}>{d.vastInstance.gpu}</span>
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 2 }}>
                  <div>id: {d.vastInstance.id} · ${d.vastInstance.hourlyRate.toFixed(4)}/hr</div>
                  <div>{d.vastInstance.vcpus} vCPU · {d.vastInstance.ramGb}GB RAM · {d.vastInstance.diskGb}GB disk</div>
                  <div>{d.vastInstance.ip}:{d.vastInstance.sshPort}</div>
                </div>
              </div>
            ) : (
              <div className="loading-dim">instance unavailable</div>
            )}
            {d.vastBalance && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-bright)" }}>
                  ${((d.vastBalance.balance) + (d.vastBalance.credit)).toFixed(2)} total
                </div>
                {d.vastBalance.runwayHours && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
                    {d.vastBalance.runwayHours}h runway
                  </div>
                )}
              </div>
            )}
            {d.vastHost && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                <div className="w-label">remote host stats</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div><span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, marginRight: 6 }}>CPU</span><PctBar pct={d.vastHost.cpuPct} /></div>
                  <div><span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, marginRight: 6 }}>RAM</span><PctBar pct={d.vastHost.ramPct} /></div>
                  <div><span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, marginRight: 6 }}>GPU</span><PctBar pct={d.vastHost.gpuUtilPct} /></div>
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
                  sampled {fmtAge(Math.round((Date.now() - d.vastHost.sampledAt) / 1000))}
                </div>
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      {/* Services */}
      <SectionCard title="services" id="services" defaultOpen={true}>
        <div className="section-card-body" style={{ padding: "12px 14px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {d.services.map((s) => (
              <div key={s.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span className={`svc-pill ${s.status}`}>
                  <span className="dot" />
                  {s.name}
                </span>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => setModal({ type: "service-restart", service: s.name })}
                >
                  restart
                </button>
              </div>
            ))}
          </div>
        </div>
      </SectionCard>

      {/* Timers */}
      <SectionCard title="timers" defaultOpen={false}>
        <div className="section-card-body table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>timer</th><th>state</th><th>last trigger</th><th>next elapse</th><th>last result</th><th></th>
            </tr></thead>
            <tbody>
              {d.timers.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td><Pill color={t.active ? "green" : "red"}>{t.active ? "active" : "inactive"}</Pill></td>
                  <td className="mono dim" style={{ fontSize: 11 }}>{t.lastTrigger ?? "—"}</td>
                  <td className="mono dim" style={{ fontSize: 11 }}>{t.nextElapse ?? "—"}</td>
                  <td>
                    {t.lastResult ? (
                      <Pill color={t.lastResult === "success" ? "green" : "amber"}>{t.lastResult}</Pill>
                    ) : "—"}
                  </td>
                  <td>
                    {(t.name === "model-health-check" || t.name === "mimule-backup") && (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setModal({ type: "run-timer", timer: t.name })}
                      >
                        run now
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
