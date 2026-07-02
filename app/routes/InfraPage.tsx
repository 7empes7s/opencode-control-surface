import { useState } from "react";
import { useApi, fmtAge } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { ConfirmModal } from "../components/ConfirmModal";
import { SectionCard } from "../components/SectionCard";
import { authFetch } from "../lib/authFetch";
import type { InfraDetail } from "../../server/api/types";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function PctBar({ pct, warn = 80, crit = 95 }: { pct: number; warn?: number; crit?: number }) {
  const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  const tone = safePct >= crit ? "crit" : safePct >= warn ? "warn" : "ok";
  return (
    <div className={`resource-meter ${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(safePct)}>
      <div className="resource-meter-track">
        <div className="resource-meter-fill" style={{ width: `${safePct}%` }} />
      </div>
      <span className="resource-meter-value">{Math.round(safePct)}%</span>
    </div>
  );
}

type Modal =
  | { type: "service-restart"; service: string }
  | { type: "run-timer"; timer: string }
  | { type: "exec-action"; actionId: string; title: string; message: string; danger?: boolean };

async function execAction(actionId: string, reason: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await authFetch("/api/actions/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId, confirmed: true, reason }),
    });
    const json = await res.json() as { ok?: boolean; message?: string; error?: string };
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true, message: json.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function InfraPage() {
  const { data, loading, error, refresh } = useApi<InfraDetail>("/api/infra", 30_000);
  const [modal, setModal] = useState<Modal | null>(null);
  const [execLoading, setExecLoading] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [execSuccess, setExecSuccess] = useState<string | null>(null);
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
            modal.type === "service-restart" ? `Restart ${modal.service}?` :
            modal.type === "run-timer" ? `Run ${modal.timer} now?` :
            modal.title
          }
          message={
            modal.type === "service-restart"
              ? `This will restart the ${modal.service} service. Brief downtime expected.`
              : modal.type === "run-timer"
              ? `This will immediately trigger the ${modal.timer} timer service.`
              : modal.message
          }
          confirmLabel={
            modal.type === "service-restart" ? "Restart" :
            modal.type === "run-timer" ? "Run now" :
            "Confirm"
          }
          danger={modal.type === "service-restart" || (modal.type === "exec-action" && modal.danger)}
          inputLabel={modal.type === "exec-action" ? "Reason" : undefined}
          inputPlaceholder="Why is this action needed?"
          loading={svcAction.loading || timerAction.loading || execLoading}
          error={svcAction.error ?? timerAction.error ?? execError}
          onCancel={() => {
            setModal(null);
            svcAction.reset();
            timerAction.reset();
            setExecError(null);
          }}
          onConfirm={async (reason) => {
            let ok = false;
            if (modal.type === "service-restart") {
              ok = await svcAction.run({ service: modal.service });
            } else if (modal.type === "run-timer") {
              ok = await timerAction.run({ timer: modal.timer });
            } else if (modal.type === "exec-action") {
              setExecLoading(true);
              setExecError(null);
              const result = await execAction(modal.actionId, reason ?? "");
              setExecLoading(false);
              if (result.ok) {
                setExecSuccess(result.message ?? "done");
                ok = true;
              } else {
                setExecError(result.error ?? "failed");
              }
            }
            if (ok) { setModal(null); refresh(); }
          }}
        />
      )}

      {/* Operations */}
      <SectionCard title="operations" id="ops" defaultOpen={true}>
        <div className="section-card-body" style={{ padding: "12px 14px" }}>
          {execSuccess && (
            <div className="action-feedback ok" style={{ marginBottom: 8, fontSize: 12 }}>{execSuccess}</div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              className="btn btn-sm btn-ghost"
              style={{ minHeight: 44 }}
              onClick={() => {
                setExecSuccess(null);
                setModal({
                  type: "exec-action",
                  actionId: "start-job:infra:vast-reconcile",
                  title: "Run vast-reconcile?",
                  message: "Runs /usr/local/sbin/vast-reconcile.sh to reconcile the Vast GPU tunnel state.",
                });
              }}
            >
              Vast reconcile
            </button>
            <button
              className="btn btn-sm btn-ghost"
              style={{ minHeight: 44 }}
              onClick={() => {
                setExecSuccess(null);
                setModal({
                  type: "exec-action",
                  actionId: "start-job:infra:doctor-log-rotate",
                  title: "Rotate doctor log?",
                  message: "Compresses the current doctor-log.jsonl and resets it. Useful when the log exceeds the retention limit.",
                });
              }}
            >
              Rotate doctor log
            </button>
            <button
              className="btn btn-sm btn-ghost"
              style={{ minHeight: 44 }}
              onClick={() => {
                setExecSuccess(null);
                setModal({
                  type: "exec-action",
                  actionId: "start-job:infra:litellm-reload",
                  title: "Reload LiteLLM config?",
                  message: "Restarts the LiteLLM service so it picks up config changes. Brief (~10s) gateway downtime expected.",
                  danger: true,
                });
              }}
            >
              LiteLLM reload
            </button>
            <button
              className="btn btn-sm btn-danger"
              style={{ minHeight: 44 }}
              onClick={() => {
                setExecSuccess(null);
                setModal({
                  type: "service-restart",
                  service: "cloudflared",
                });
              }}
            >
              Cloudflared restart
            </button>
          </div>
        </div>
      </SectionCard>

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
              <Pill color={d.gpu.status === "up" ? "green" : d.gpu.status === "down" ? "red" : d.gpu.status === "off" ? "gray" : "amber"}>{d.gpu.status}</Pill>
              {d.gpu.gpuUtil !== null && <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{d.gpu.gpuUtil}% util</span>}
            </div>
            {d.gpu.note && (
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>{d.gpu.note}</div>
            )}
            {d.gpu.loadedModels.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                {d.gpu.loadedModels.map((m) => <span key={m} className="chain-model">{m}</span>)}
              </div>
            )}
            {d.gpu.status !== "off" && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
                checked {d.gpu.checkedAgo >= 0 ? fmtAge(d.gpu.checkedAgo) : "—"}
              </div>
            )}
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
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              <div className="w-label">remote host stats</div>
              {d.vastHost && d.vastHost.status === "ok" ? (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div><span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, marginRight: 6 }}>CPU</span><PctBar pct={d.vastHost.cpuPct ?? 0} /></div>
                    <div><span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, marginRight: 6 }}>RAM</span><PctBar pct={d.vastHost.ramPct ?? 0} /></div>
                    <div><span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, marginRight: 6 }}>GPU</span><PctBar pct={d.vastHost.gpuUtilPct ?? 0} /></div>
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
                    sampled {fmtAge(Math.round((Date.now() - d.vastHost.sampledAt) / 1000))}
                  </div>
                </>
              ) : d.vastHost ? (
                <div style={{ marginTop: 4 }}>
                  <Pill color={d.vastHost.status === "unreachable" ? "red" : "gray"}>{d.vastHost.status}</Pill>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
                    {d.vastHost.reason ?? "No host metrics available."}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                    last sampler run {fmtAge(Math.round((Date.now() - d.vastHost.sampledAt) / 1000))}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
                  The host sampler has not run yet — it runs every 5 minutes inside the dashboard ingestor.
                </div>
              )}
            </div>
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
                  style={{ minHeight: 44 }}
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
                    {t.runnable ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ minHeight: 44 }}
                        onClick={() => setModal({ type: "run-timer", timer: t.name })}
                      >
                        run now
                      </button>
                    ) : (
                      <span className="dim" style={{ fontSize: 10 }}>not allowed</span>
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
