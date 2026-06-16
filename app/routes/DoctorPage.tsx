import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { useAction } from "../hooks/useAction";
import type { DoctorDetail } from "../../server/api/types";
import { SectionCard } from "../components/SectionCard";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function verdictColor(action: string): string {
  if (["requeued", "promoted", "retry", "retry_escalate", "skip_stage"].includes(action)) return "green";
  if (["kill", "dead-content", "dead_content", "abandoned"].includes(action)) return "red";
  if (["cooldown", "reroute_provider", "escalate", "waiting-quota", "waiting-gpu"].includes(action)) return "amber";
  return "gray";
}

function DoctorLoadingState({ error }: { error?: string | null }) {
  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Doctor</div>
        <div className={`loading-panel${error ? " error" : ""}`} style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600 }}>{error ? "Doctor data did not load" : "Loading doctor data"}</div>
          <div>{error ? `The API returned: ${error}` : "Waiting for repair stats, charts, and the decision log."}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8, marginBottom: 16 }}>
        {["error classes (24h)", "top failing models", "verdict mix"].map((title) => (
          <SectionCard key={title} title={title} defaultOpen={true}>
            <div className="section-card-body" style={{ padding: "12px 16px" }}>
              <div className="skeleton-line wide" />
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
            </div>
          </SectionCard>
        ))}
      </div>
      <SectionCard title="decision log" defaultOpen={true}>
        <div className="section-card-body" style={{ padding: "12px 16px" }}>
          <div className="skeleton-line wide" />
          <div className="skeleton-line wide" />
          <div className="skeleton-line" />
        </div>
      </SectionCard>
    </div>
  );
}

export function DoctorPage() {
  const { data, loading, error, refresh } = useApi<DoctorDetail>("/api/doctor", 15_000);
  const scan = useAction("/api/doctor/scan");
  const [filterStage, setFilterStage] = useState("");
  const [filterError, setFilterError] = useState("");
  const [filterModel, setFilterModel] = useState("");

  if (loading && !data) return <DoctorLoadingState />;
  if (error && !data) return <DoctorLoadingState error={error} />;
  if (!data) return <DoctorLoadingState error="No doctor data is available yet." />;

  const d = data;
  const successPct = d.stats.total > 0 ? Math.round(d.stats.successRate * 100) : null;

  const filtered = d.entries.filter((e) => {
    if (filterStage && e.stage !== filterStage) return false;
    if (filterError && e.errorType !== filterError) return false;
    if (filterModel && e.failedModel !== filterModel) return false;
    return true;
  }).slice().reverse(); // newest first

  // Unique values for filters
  const stages = [...new Set(d.entries.map((e) => e.stage).filter(Boolean))].sort();
  const errorTypes = [...new Set(d.entries.map((e) => e.errorType).filter(Boolean))].sort();
  const models = [...new Set(d.entries.map((e) => e.failedModel).filter(Boolean))].sort();

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Doctor</div>
        <div className="stat-row">
          <div className="stat-item">
            <div className="stat-val">{d.stats.total}</div>
            <div className="stat-lbl">repairs 24h</div>
          </div>
          {successPct !== null && (
            <div className="stat-item">
              <div className="stat-val">{successPct}%</div>
              <div className="stat-lbl">success rate</div>
            </div>
          )}
          {d.lastDecision && (
            <div className="stat-item">
              <div className="stat-lbl">last decision</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                {d.lastDecision.slug} · <Pill color={verdictColor(d.lastDecision.action)}>{d.lastDecision.action}</Pill>
              </div>
            </div>
          )}
        </div>
        <div className="action-bar" style={{ marginTop: 12 }}>
          <button
            className="btn btn-ghost"
            disabled={scan.loading}
            onClick={async () => {
              const ok = await scan.run();
              if (ok) refresh();
            }}
          >
            {scan.loading ? "Running scan..." : "Run doctor scan"}
          </button>
          {scan.success && <span className="action-feedback ok">{scan.success}</span>}
          {scan.error && <span className="action-feedback err">{scan.error}</span>}
        </div>
      </div>

      {/* Stats charts */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8, marginBottom: 16 }}>
        <SectionCard title="error classes (24h)" id="errors" defaultOpen={true}>
          <div className="section-card-body" style={{ padding: "10px 14px" }}>
            {d.stats.errorClasses.length === 0 ? <div className="loading-dim">none</div> : (
              <ResponsiveContainer width="100%" height={Math.max(60, d.stats.errorClasses.length * 22)}>
                <BarChart
                  layout="vertical"
                  data={d.stats.errorClasses}
                  margin={{ top: 0, right: 30, bottom: 0, left: 0 }}
                >
                  <XAxis type="number" hide />
                  <YAxis
                    type="category" dataKey="type" width={130}
                    tick={{ fontFamily: "var(--mono)", fontSize: 10, fill: "#666" }}
                    axisLine={false} tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{ background: "#111", border: "1px solid #222", borderRadius: 3, fontFamily: "var(--mono)", fontSize: 11 }}
                    itemStyle={{ color: "#f87171" }}
                    formatter={(v: number) => [v, "events"]}
                  />
                  <Bar dataKey="count" fill="#f87171" opacity={0.7} radius={[0, 2, 2, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </SectionCard>

        <SectionCard title="top failing models" id="models" defaultOpen={false}>
          <div className="section-card-body" style={{ padding: "10px 14px" }}>
            {d.stats.topFailingModels.length === 0 ? <div className="loading-dim">none</div> : (
              d.stats.topFailingModels.map((m) => (
                <div key={m.model} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "80%" }}>{m.model}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>{m.count}</span>
                </div>
              ))
            )}
          </div>
        </SectionCard>

        <SectionCard title="verdict mix" id="verdicts" defaultOpen={false}>
          <div className="section-card-body" style={{ padding: "10px 14px" }}>
            {d.stats.verdictMix.length === 0 ? <div className="loading-dim">none</div> : (() => {
              const COLORS: Record<string, string> = {
                retry: "#4ade80", requeued: "#4ade80",
                "dead-content": "#f87171", kill: "#f87171",
                cooldown: "#f59e0b", no_action: "#555",
              };
              return (
                <ResponsiveContainer width="100%" height={120}>
                  <PieChart>
                    <Pie
                      data={d.stats.verdictMix} dataKey="count" nameKey="action"
                      cx="50%" cy="50%" outerRadius={48} innerRadius={24}
                    >
                      {d.stats.verdictMix.map((v) => (
                        <Cell key={v.action} fill={COLORS[v.action] ?? "#555"} opacity={0.8} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: "#111", border: "1px solid #222", borderRadius: 3, fontFamily: "var(--mono)", fontSize: 11 }}
                    />
                    <Legend
                      iconType="circle" iconSize={7}
                      formatter={(value: string) => <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#888" }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
              );
            })()}
          </div>
        </SectionCard>
      </div>

      {/* Full log */}
      <SectionCard
        title="decision log"
        defaultOpen={false}
        right={<span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{d.entries.length} entries</span>}
      >
        <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={filterStage} onChange={(e) => setFilterStage(e.target.value)}
            style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)", padding: "3px 8px", borderRadius: 3 }}>
            <option value="">all stages</option>
            {stages.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filterError} onChange={(e) => setFilterError(e.target.value)}
            style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)", padding: "3px 8px", borderRadius: 3 }}>
            <option value="">all errors</option>
            {errorTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={filterModel} onChange={(e) => setFilterModel(e.target.value)}
            style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)", padding: "3px 8px", borderRadius: 3 }}>
            <option value="">all models</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {(filterStage || filterError || filterModel) && (
            <button onClick={() => { setFilterStage(""); setFilterError(""); setFilterModel(""); }}
              style={{ fontFamily: "var(--mono)", fontSize: 11, background: "none", border: "1px solid var(--border)", color: "var(--text-dim)", padding: "3px 8px", borderRadius: 3, cursor: "pointer" }}>
              clear
            </button>
          )}
        </div>
        <div className="section-card-body table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>time</th><th>slug</th><th>stage</th><th>error</th><th>model</th><th>verdict</th><th>reason</th>
            </tr></thead>
            <tbody>
              {filtered.slice(0, 200).map((e, i) => (
                <tr key={i}>
                  <td className="mono dim" style={{ whiteSpace: "nowrap" }}>{e.ts.slice(0, 19).replace("T", " ")}</td>
                  <td className="mono trunc" style={{ maxWidth: 160 }}>{e.slug}</td>
                  <td className="mono">{e.stage}</td>
                  <td className="mono dim" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.errorType}</td>
                  <td className="mono dim trunc" style={{ maxWidth: 140 }}>{e.failedModel}</td>
                  <td><Pill color={verdictColor(e.action)}>{e.action}</Pill></td>
                  <td className="dim" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 200 && (
            <div className="loading-dim">showing 200 of {filtered.length} entries</div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
