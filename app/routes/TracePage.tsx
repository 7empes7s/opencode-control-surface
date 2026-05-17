import { useState } from "react";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { SectionCard } from "../components/SectionCard";

type SpanKind = "run" | "pass" | "tool" | "gateway" | "validation";
type SpanStatus = "ok" | "error" | "cancelled";

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  startMs: number;
  endMs: number | null;
  attrs: Record<string, string | number | boolean>;
  status: SpanStatus;
  error?: string;
};

function kindColor(kind: SpanKind): string {
  if (kind === "run") return "var(--trace-run)";
  if (kind === "pass") return "var(--trace-pass)";
  if (kind === "tool") return "var(--trace-tool)";
  if (kind === "gateway") return "var(--trace-gateway)";
  if (kind === "validation") return "var(--trace-validation)";
  return "var(--text-dim)";
}

function statusPill(status: SpanStatus) {
  const color = status === "ok" ? "green" : status === "error" ? "red" : "amber";
  return <span className={`pill ${color}`}>{status}</span>;
}

function fmtTs(ms: number) {
  return new Date(ms).toISOString().slice(11, 19);
}

function durMs(span: Span): string {
  if (!span.endMs) return "…";
  return `${span.endMs - span.startMs}ms`;
}

function SpanRow({ span, onClick, selected }: { span: Span; onClick: () => void; selected: boolean }) {
  return (
    <tr
      onClick={onClick}
      style={{ cursor: "pointer", background: selected ? "color-mix(in oklch, var(--accent) 10%, transparent)" : undefined }}
    >
      <td style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>{span.traceId.slice(0, 8)}</td>
      <td>
        <span style={{ background: kindColor(span.kind), color: "#fff", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 600 }}>
          {span.kind}
        </span>
      </td>
      <td>{statusPill(span.status)}</td>
      <td style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{durMs(span)}</td>
      <td style={{ fontSize: 10, color: "var(--text-dim)" }}>{fmtTs(span.startMs)} UTC</td>
    </tr>
  );
}

function SpanDetail({ span }: { span: Span }) {
  return (
    <div style={{ padding: "12px 16px", background: "var(--bg-card-start)", borderRadius: 8, fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Span: {span.spanId.slice(0, 16)}…</div>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "4px 12px" }}>
        <span style={{ color: "var(--text-dim)" }}>Trace ID</span><span style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{span.traceId}</span>
        <span style={{ color: "var(--text-dim)" }}>Kind</span><span>{span.kind}</span>
        <span style={{ color: "var(--text-dim)" }}>Status</span><span>{statusPill(span.status)}</span>
        <span style={{ color: "var(--text-dim)" }}>Start</span><span style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{new Date(span.startMs).toISOString()}</span>
        <span style={{ color: "var(--text-dim)" }}>End</span><span style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{span.endMs ? new Date(span.endMs).toISOString() : "—"}</span>
        <span style={{ color: "var(--text-dim)" }}>Duration</span><span>{durMs(span)}</span>
        {span.parentSpanId && <><span style={{ color: "var(--text-dim)" }}>Parent</span><span style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{span.parentSpanId.slice(0, 16)}</span></>}
        {span.error && <><span style={{ color: "var(--text-dim)" }}>Error</span><span style={{ color: "var(--text-red, red)" }}>{span.error}</span></>}
      </div>
      {Object.keys(span.attrs).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 11 }}>Attributes</div>
          <pre style={{ fontFamily: "var(--mono)", fontSize: 10, background: "color-mix(in oklch, black 15%, transparent)", borderRadius: 6, padding: "8px 10px", overflowX: "auto", margin: 0 }}>
            {JSON.stringify(span.attrs, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function TracePage() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterKind, setFilterKind] = useState<string>("");

  const { data: datesData, loading: datesLoading } = useAuthenticatedApi<{ dates: string[] }>("/api/traces", 60_000);
  const dates = datesData?.dates ?? [];

  const activeDate = selectedDate ?? dates[0] ?? "";
  const { data: spansData, loading: spansLoading } = useAuthenticatedApi<{ date: string; spans: Span[] }>(
    activeDate ? `/api/traces/${activeDate}` : "/api/traces",
    30_000,
  );

  const spans = (spansData?.spans ?? []).filter((s) => {
    if (filterStatus && s.status !== filterStatus) return false;
    if (filterKind && s.kind !== filterKind) return false;
    return true;
  });

  const grouped = spans.reduce<Record<string, Span[]>>((acc, s) => {
    (acc[s.traceId] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="dash-page">
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Traces</h1>

      {datesLoading && <p style={{ color: "var(--text-dim)" }}>Loading…</p>}

      {!datesLoading && dates.length === 0 && (
        <SectionCard title="No traces yet">
          <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
            Traces are emitted when builder runs execute. Start a workflow run to generate trace data.
          </p>
        </SectionCard>
      )}

      {dates.length > 0 && (
        <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          {/* Date list */}
          <div style={{ minWidth: 140, flexShrink: 0 }}>
            <SectionCard title="Dates">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {dates.map((d) => (
                  <button
                    key={d}
                    onClick={() => { setSelectedDate(d); setSelectedSpan(null); }}
                    style={{
                      padding: "5px 10px", borderRadius: 6, textAlign: "left", fontSize: 12,
                      fontFamily: "var(--mono)",
                      background: d === activeDate && activeDate ? "var(--accent)" : "transparent",
                      color: d === activeDate && activeDate ? "var(--text-bright)" : "var(--text-dim)",
                      border: "none", cursor: "pointer",
                    }}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </SectionCard>
          </div>

          {/* Span list */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <SectionCard title={`Spans — ${activeDate ?? ""}`}>
              <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ fontSize: 11, padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-card-start)", color: "var(--text)" }}>
                  <option value="">All statuses</option>
                  <option value="ok">ok</option>
                  <option value="error">error</option>
                  <option value="cancelled">cancelled</option>
                </select>
                <select value={filterKind} onChange={(e) => setFilterKind(e.target.value)} style={{ fontSize: 11, padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-card-start)", color: "var(--text)" }}>
                  <option value="">All kinds</option>
                  <option value="run">run</option>
                  <option value="pass">pass</option>
                  <option value="tool">tool</option>
                  <option value="gateway">gateway</option>
                  <option value="validation">validation</option>
                </select>
                <span style={{ fontSize: 11, color: "var(--text-dim)", alignSelf: "center" }}>
                  {spans.length} span{spans.length !== 1 ? "s" : ""} · {Object.keys(grouped).length} trace{Object.keys(grouped).length !== 1 ? "s" : ""}
                </span>
              </div>

              {spansLoading && <p style={{ fontSize: 12, color: "var(--text-dim)" }}>Loading…</p>}

              {!spansLoading && spans.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--text-dim)" }}>No spans match the current filters.</p>
              )}

              {spans.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 10 }}>
                        <th style={{ textAlign: "left", padding: "4px 8px 4px 0" }}>Trace</th>
                        <th style={{ textAlign: "left", padding: "4px 8px 4px 0" }}>Kind</th>
                        <th style={{ textAlign: "left", padding: "4px 8px 4px 0" }}>Status</th>
                        <th style={{ textAlign: "left", padding: "4px 8px 4px 0" }}>Duration</th>
                        <th style={{ textAlign: "left", padding: "4px 8px 4px 0" }}>Start</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spans.map((s) => (
                        <SpanRow
                          key={s.spanId}
                          span={s}
                          selected={selectedSpan?.spanId === s.spanId}
                          onClick={() => setSelectedSpan(selectedSpan?.spanId === s.spanId ? null : s)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {selectedSpan && (
                <div style={{ marginTop: 16 }}>
                  <SpanDetail span={selectedSpan} />
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  );
}
