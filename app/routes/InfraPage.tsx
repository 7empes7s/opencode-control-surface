import { useState } from "react";
import { Link } from "wouter";
import { useApi, fmtAge } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import { ConfirmModal } from "../components/ConfirmModal";
import { authFetch } from "../lib/authFetch";
import type { InfraDetail } from "../../server/api/types";
import { Reveal, SectionHead } from "../components/v5/ui";
import { Activity, Cloud, Cpu, Server, Timer, Wrench } from "lucide-react";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  const tone = color === "green" ? "ok" : color === "amber" ? "warn" : color === "red" ? "err" : color === "blue" ? "info" : "";
  return <span className={`v5-pill${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

function PctBar({ pct, warn = 80, crit = 95 }: { pct: number; warn?: number; crit?: number }) {
  const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  const fill = safePct >= crit ? "var(--red)" : safePct >= warn ? "var(--amber-warn)" : "var(--grad-accent)";
  return (
    <div
      role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(safePct)}
      style={{ display: "flex", alignItems: "center", gap: 10 }}
    >
      <div style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--bg-sub)", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${safePct}%`,
            borderRadius: 999,
            background: fill,
            transition: "width 0.9s var(--ease-out, ease)",
          }}
        />
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", minWidth: 36, textAlign: "right" }}>
        {Math.round(safePct)}%
      </span>
    </div>
  );
}

function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 5, letterSpacing: "0.06em", textTransform: "uppercase" }}>
      {children}
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

const SMALL_BTN = { minHeight: 34, padding: "6px 12px", fontSize: 12 } as const;

export function InfraPage() {
  const { data, loading, error, refresh } = useApi<InfraDetail>("/api/infra", 30_000);
  const [modal, setModal] = useState<Modal | null>(null);
  const [execLoading, setExecLoading] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [execSuccess, setExecSuccess] = useState<string | null>(null);
  const svcAction = useAction("/api/infra/service-restart");
  const timerAction = useAction("/api/infra/run-timer");

  if (loading && !data) {
    return (
      <div className="dash-page">
        <div className="v5-pagehead">
          <div className="v5-pagehead-title">Infrastructure</div>
          <div className="v5-pagehead-sub">Hetzner / Vast / GPU / services.</div>
        </div>
        <div className="v5-grid cards">
          {[0, 1, 2].map((i) => <div key={i} className="v5-skeleton" style={{ height: 180 }} />)}
        </div>
        <div className="v5-section"><div className="v5-skeleton" style={{ height: 220 }} /></div>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="dash-page">
        <div className="v5-pagehead">
          <div className="v5-pagehead-title">Infrastructure</div>
          <div className="v5-pagehead-sub">Hetzner / Vast / GPU / services.</div>
        </div>
        <div className="v5-card" style={{ color: "var(--red)", fontSize: 13 }}>Infrastructure data did not load: {error}</div>
      </div>
    );
  }
  if (!data) return null;

  const d = data;
  const h = d.hetzner;
  const memGb = h.memTotalKb > 0 ? (h.memTotalKb / 1024 / 1024).toFixed(1) : "?";
  const memUsedGb = (h.memUsedKb / 1024 / 1024).toFixed(1);

  return (
    <div className="dash-page">
      <div className="v5-pagehead">
        <div className="v5-pagehead-title">Infrastructure</div>
        <div className="v5-pagehead-sub">Hetzner / Vast / GPU / services.</div>
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

      {/* Durable-job-backed restart/timer actions now return a jobId
          (SPEC 14 / ULTRAPLAN P3 A3a) — surface it so the operator can see
          the mutation is tracked and retryable on /jobs, never silent. */}
      {(svcAction.jobId || timerAction.jobId) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
          {svcAction.jobId && (
            <div className="action-feedback ok" style={{ fontSize: 12 }}>
              job <span style={{ fontFamily: "var(--mono)" }}>{svcAction.jobId}</span> started —{" "}
              <Link href="/jobs" style={{ color: "var(--accent)" }}>view</Link>
            </div>
          )}
          {timerAction.jobId && (
            <div className="action-feedback ok" style={{ fontSize: 12 }}>
              job <span style={{ fontFamily: "var(--mono)" }}>{timerAction.jobId}</span> started —{" "}
              <Link href="/jobs" style={{ color: "var(--accent)" }}>view</Link>
            </div>
          )}
        </div>
      )}

      {/* Operations */}
      <Reveal delay={0.02}>
        <div className="v5-section" id="ops" style={{ marginTop: 0 }}>
          <SectionHead title="Operations" icon={<Wrench size={16} />} />
          <div className="v5-card flat-hover">
            {execSuccess && (
              <div className="action-feedback ok" style={{ marginBottom: 10, fontSize: 12 }}>{execSuccess}</div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                className="v5-btn ghost"
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
                className="v5-btn ghost"
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
                className="v5-btn ghost"
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
                className="v5-btn ghost"
                style={{ color: "var(--red)" }}
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
        </div>
      </Reveal>

      <Reveal delay={0.06}>
        <div className="v5-grid cards" style={{ marginTop: 18 }}>

          {/* Hetzner */}
          <div className="v5-card flat-hover" id="hetzner">
            <div className="v5-card-label"><Server size={13} /> hetzner CX32</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <CardLabel>memory ({memUsedGb} / {memGb} GB)</CardLabel>
                <PctBar pct={h.memUsedPct} />
              </div>
              <div>
                <CardLabel>disk ({h.diskUsedGb} / {h.diskTotalGb} GB)</CardLabel>
                <PctBar pct={h.diskUsedPct} />
              </div>
              <div>
                <CardLabel>load avg</CardLabel>
                <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)" }}>
                  {h.load1.toFixed(2)} · {h.load5.toFixed(2)} · {h.load15.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* GPU / vast */}
          <div className="v5-card flat-hover" id="gpu">
            <div className="v5-card-label"><Cpu size={13} /> gpu tunnel</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
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

          {/* Vast instance */}
          <div className="v5-card flat-hover" id="vast">
            <div className="v5-card-label"><Cloud size={13} /> vast.ai instance</div>
            {d.vastInstance ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
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
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Instance unavailable.</div>
            )}
            {d.vastBalance && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
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
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <CardLabel>remote host stats</CardLabel>
              {d.vastHost && d.vastHost.status === "ok" ? (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "34px 1fr", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>CPU</span>
                      <PctBar pct={d.vastHost.cpuPct ?? 0} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "34px 1fr", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>RAM</span>
                      <PctBar pct={d.vastHost.ramPct ?? 0} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "34px 1fr", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>GPU</span>
                      <PctBar pct={d.vastHost.gpuUtilPct ?? 0} />
                    </div>
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 8 }}>
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
        </div>
      </Reveal>

      {/* Services */}
      <Reveal delay={0.1}>
        <div className="v5-section" id="services">
          <SectionHead title="Services" icon={<Activity size={16} />} />
          <div className="v5-card flat-hover">
            <div style={{ display: "flex", flexDirection: "column" }}>
              {d.services.map((s, i) => (
                <div
                  key={s.name}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                    padding: "9px 0",
                    borderTop: i === 0 ? "none" : "1px solid var(--border)",
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)" }}>
                    <span className={`v5-dot ${s.status === "active" ? "ok" : s.status === "failed" ? "err" : "warn"}`} />
                    {s.name}
                    <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{s.status}</span>
                  </span>
                  <button
                    className="v5-btn ghost"
                    style={{ ...SMALL_BTN, color: "var(--red)" }}
                    onClick={() => setModal({ type: "service-restart", service: s.name })}
                  >
                    restart
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Reveal>

      {/* Timers */}
      <Reveal delay={0.14}>
        <div className="v5-section">
          <SectionHead title="Timers" icon={<Timer size={16} />} />
          <div className="v5-card flat-hover">
            <div className="v5-table-wrap">
              <table className="v5-table responsive">
                <thead><tr>
                  <th>Timer</th><th>State</th><th>Last trigger</th><th>Next elapse</th><th>Last result</th><th>Actions</th>
                </tr></thead>
                <tbody>
                  {d.timers.map((t) => (
                    <tr key={t.name}>
                      <td data-label="Timer" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{t.name}</td>
                      <td data-label="State"><Pill color={t.active ? "green" : "red"}>{t.active ? "active" : "inactive"}</Pill></td>
                      <td data-label="Last trigger" style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>{t.lastTrigger ?? "—"}</td>
                      <td data-label="Next elapse" style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>{t.nextElapse ?? "—"}</td>
                      <td data-label="Last result">
                        {t.lastResult ? (
                          <Pill color={t.lastResult === "success" ? "green" : "amber"}>{t.lastResult}</Pill>
                        ) : "—"}
                      </td>
                      <td data-label="Actions">
                        {t.runnable ? (
                          <button
                            className="v5-btn ghost"
                            style={SMALL_BTN}
                            onClick={() => setModal({ type: "run-timer", timer: t.name })}
                          >
                            run now
                          </button>
                        ) : (
                          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>not allowed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Reveal>
    </div>
  );
}
