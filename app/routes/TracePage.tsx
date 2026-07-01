import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { SectionCard } from "../components/SectionCard";
import { TableControls } from "../components/TableControls";
import { DetailDrawer } from "../components/DetailDrawer";
import { useTableControls } from "../hooks/useTableControls";

type SpanKind = "run" | "pass" | "tool" | "gateway" | "validation";
type SpanStatus = "ok" | "error" | "cancelled";

type GatewayCall = {
  ts: number;
  logicalModel: string;
  resolvedModel: string;
  latencyMs: number | null;
  tokens: number;
  success: boolean;
  errorClass: string | null;
};

type GatewayTrace = {
  traceId: string | null;
  caller: string | null;
  calls: GatewayCall[];
  totalLatencyMs: number;
  totalTokens: number;
  started: number;
};

type GatewayTracesResponse = {
  traces: GatewayTrace[];
  windowMs: number;
  total: number;
  degraded: boolean;
  reason?: string;
};

function fmtTsShort(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function fmtStartedAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function uniqueModels(trace: GatewayTrace): string {
  const seen = new Set<string>();
  for (const c of trace.calls) seen.add(c.logicalModel);
  return Array.from(seen).join(", ") || "—";
}

function failCount(trace: GatewayTrace): number {
  return trace.calls.filter((c) => !c.success).length;
}

function traceKey(trace: GatewayTrace): string {
  return trace.traceId ?? `untraced-${trace.started}-${trace.calls[0]?.ts ?? 0}`;
}

function GatewayTraceDetail({ trace }: { trace: GatewayTrace }) {
  return (
    <>
      <div className="data-row-detail-grid">
        <div><span>Trace ID</span><strong>{trace.traceId ?? "untraced call"}</strong></div>
        <div><span>Caller</span><strong>{trace.caller ?? "unknown"}</strong></div>
        <div><span>Started</span><strong>{new Date(trace.started).toISOString()}</strong></div>
        <div><span>Calls</span><strong>{trace.calls.length}</strong></div>
        <div><span>Tokens</span><strong>{trace.totalTokens.toLocaleString()}</strong></div>
        <div><span>Total latency</span><strong>{trace.totalLatencyMs}ms</strong></div>
      </div>
      <div className="evidence-block">
        <div className="evidence-block-title">LLM calls</div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Logical</th>
                <th>Resolved</th>
                <th className="cell-right">Latency</th>
                <th className="cell-right">Tokens</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {trace.calls.map((call, index) => (
                <tr key={`${call.ts}-${index}`}>
                  <td className="mono cell-ellipsis">{fmtTsShort(call.ts)}</td>
                  <td className="mono cell-ellipsis">{call.logicalModel}</td>
                  <td className="mono cell-ellipsis dim">{call.resolvedModel}</td>
                  <td className="cell-right mono">{call.latencyMs === null ? "—" : `${call.latencyMs}ms`}</td>
                  <td className="cell-right mono">{call.tokens.toLocaleString()}</td>
                  <td>
                    {call.success ? (
                      <span className="pill green">ok</span>
                    ) : (
                      <span className="pill red">{call.errorClass ?? "failed"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="evidence-block">
        <div className="evidence-block-title">Raw trace</div>
        <pre className="audit-pre detail-json">{JSON.stringify(trace, null, 2)}</pre>
      </div>
    </>
  );
}

function GatewayTracesSection() {
  const [selectedTrace, setSelectedTrace] = useState<GatewayTrace | null>(null);

  const { data, loading } = useAuthenticatedApi<GatewayTracesResponse>(
    "/api/traces/gateway",
    15_000,
  );

  const traces = data?.traces ?? [];
  const degraded = data?.degraded ?? false;
  const reason = data?.reason;
  const total = data?.total ?? 0;
  const tracesCtrl = useTableControls<GatewayTrace, "started" | "caller" | "models" | "calls" | "tokens" | "latency" | "status">({
    rows: traces,
    pageSize: 10,
    pageSizeOptions: [10, 25, 50, 100],
    rowKey: traceKey,
    defaultSort: { key: "started", dir: "desc" },
    filterText: (trace) => [
      trace.traceId,
      trace.caller,
      uniqueModels(trace),
      trace.calls.map((call) => call.errorClass).filter(Boolean).join(" "),
    ],
    sortValue: (trace, key) => {
      switch (key) {
        case "started": return trace.started;
        case "caller": return trace.caller ?? "";
        case "models": return uniqueModels(trace);
        case "calls": return trace.calls.length;
        case "tokens": return trace.totalTokens;
        case "latency": return trace.totalLatencyMs;
        case "status": return failCount(trace);
        default: return "";
      }
    },
  });

  const closeTrace = () => {
    tracesCtrl.collapseAll();
    setSelectedTrace(null);
  };

  return (
    <SectionCard title="Gateway traces">
      <DetailDrawer
        open={selectedTrace !== null}
        onClose={closeTrace}
        kicker="gateway trace"
        title={selectedTrace?.traceId ?? "Untraced call"}
        summary={selectedTrace && (
          <>
            <span className={`pill ${failCount(selectedTrace) > 0 ? "red" : "green"}`}>
              {failCount(selectedTrace) > 0 ? `${failCount(selectedTrace)} failed` : "all ok"}
            </span>
            <span className="pill">{selectedTrace.calls.length} calls</span>
            <span className="pill">{selectedTrace.totalTokens.toLocaleString()} tokens</span>
            {selectedTrace.caller && <span className="pill">{selectedTrace.caller}</span>}
          </>
        )}
      >
        {selectedTrace && <GatewayTraceDetail trace={selectedTrace} />}
      </DetailDrawer>
      {loading && !data && (
        <p style={{ color: "var(--text-dim)", fontSize: 12 }}>Loading…</p>
      )}
      {!loading && degraded && (
        <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
          Traces are temporarily unavailable{reason ? ` (${reason})` : ""}. Once the gateway ledger is recording, trace groups will appear here.
        </p>
      )}
      {!loading && !degraded && traces.length === 0 && (
        <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
          No gateway calls recorded in the last 7 days. Traces group related LLM calls under a single trace ID and summarise the model, caller, and totals.
        </p>
      )}
      {!loading && !degraded && traces.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
            {total} trace group{total === 1 ? "" : "s"} · open a row for call payloads
          </div>
          <div className="table-wrap">
            <TableControls {...tracesCtrl.controlsProps} searchPlaceholder="Search trace ID, caller, model, or error..." />
            <table className="data-table">
              <thead>
                <tr>
                  <th className="expander-col" aria-label="Details" />
                  <th {...tracesCtrl.sortHeaderProps("started")}>Started <span className="sortable-th-arrow">{tracesCtrl.sort.key === "started" ? (tracesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...tracesCtrl.sortHeaderProps("caller")}>Caller <span className="sortable-th-arrow">{tracesCtrl.sort.key === "caller" ? (tracesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...tracesCtrl.sortHeaderProps("models")}>Models <span className="sortable-th-arrow">{tracesCtrl.sort.key === "models" ? (tracesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...tracesCtrl.sortHeaderProps("calls")} className="cell-right">Calls <span className="sortable-th-arrow">{tracesCtrl.sort.key === "calls" ? (tracesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...tracesCtrl.sortHeaderProps("tokens")} className="cell-right">Tokens <span className="sortable-th-arrow">{tracesCtrl.sort.key === "tokens" ? (tracesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...tracesCtrl.sortHeaderProps("latency")} className="cell-right">Latency <span className="sortable-th-arrow">{tracesCtrl.sort.key === "latency" ? (tracesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...tracesCtrl.sortHeaderProps("status")}>Status <span className="sortable-th-arrow">{tracesCtrl.sort.key === "status" ? (tracesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                </tr>
              </thead>
              <tbody>
                {tracesCtrl.rows.map((trace, index) => {
                  const key = tracesCtrl.getRowKey(trace, index);
                  const expanded = tracesCtrl.isExpanded(key);
                  const failed = failCount(trace);
                  const openTrace = () => {
                    if (!expanded) tracesCtrl.toggleExpanded(key);
                    setSelectedTrace(trace);
                  };
                  return (
                    <tr key={key} className="data-row-clickable" onClick={openTrace}>
                      <td className="expander-col">
                        <button
                          type="button"
                          className="table-expander"
                          aria-label="Open trace detail"
                          aria-expanded={expanded}
                          onClick={(event) => {
                            event.stopPropagation();
                            openTrace();
                          }}
                        >
                          <ChevronRight size={15} />
                        </button>
                      </td>
                      <td className="mono cell-ellipsis" title={trace.traceId ?? "untraced call"}>{fmtStartedAgo(trace.started)}</td>
                      <td className="cell-ellipsis" title={trace.caller ?? ""}>{trace.caller ?? "—"}</td>
                      <td className="mono cell-ellipsis cell-wide" title={uniqueModels(trace)}>{uniqueModels(trace)}</td>
                      <td className="cell-right mono">{trace.calls.length}</td>
                      <td className="cell-right mono">{trace.totalTokens.toLocaleString()}</td>
                      <td className="cell-right mono">{trace.totalLatencyMs}ms</td>
                      <td>{failed > 0 ? <span className="pill red">{failed} failed</span> : <span className="pill green">ok</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

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
  const spansCtrl = useTableControls<Span, "trace" | "kind" | "status" | "duration" | "start">({
    rows: spans,
    pageSize: 25,
    pageSizeOptions: [10, 25, 50, 100],
    rowKey: (span) => span.spanId,
    defaultSort: { key: "start", dir: "desc" },
    filterText: (span) => [
      span.traceId,
      span.spanId,
      span.parentSpanId,
      span.kind,
      span.status,
      span.error,
      JSON.stringify(span.attrs),
    ],
    sortValue: (span, key) => {
      switch (key) {
        case "trace": return span.traceId;
        case "kind": return span.kind;
        case "status": return span.status;
        case "duration": return span.endMs ? span.endMs - span.startMs : 0;
        case "start": return span.startMs;
        default: return "";
      }
    },
  });

  const grouped = spans.reduce<Record<string, Span[]>>((acc, s) => {
    (acc[s.traceId] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="dash-page">
      <DetailDrawer
        open={selectedSpan !== null}
        onClose={() => {
          spansCtrl.collapseAll();
          setSelectedSpan(null);
        }}
        kicker="builder span"
        title={selectedSpan ? `${selectedSpan.kind} · ${selectedSpan.spanId.slice(0, 16)}` : "Span detail"}
        summary={selectedSpan && (
          <>
            {statusPill(selectedSpan.status)}
            <span className="pill">{durMs(selectedSpan)}</span>
            <span className="pill">{fmtTs(selectedSpan.startMs)} UTC</span>
          </>
        )}
      >
        {selectedSpan && <SpanDetail span={selectedSpan} />}
      </DetailDrawer>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Traces</h1>

      <div style={{ marginBottom: 16 }}>
        <GatewayTracesSection />
      </div>

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
                <div className="table-wrap">
                  <TableControls {...spansCtrl.controlsProps} searchPlaceholder="Search trace ID, span ID, kind, status, error, or attributes..." />
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="expander-col" aria-label="Details" />
                        <th {...spansCtrl.sortHeaderProps("trace")}>Trace <span className="sortable-th-arrow">{spansCtrl.sort.key === "trace" ? (spansCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...spansCtrl.sortHeaderProps("kind")}>Kind <span className="sortable-th-arrow">{spansCtrl.sort.key === "kind" ? (spansCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...spansCtrl.sortHeaderProps("status")}>Status <span className="sortable-th-arrow">{spansCtrl.sort.key === "status" ? (spansCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...spansCtrl.sortHeaderProps("duration")}>Duration <span className="sortable-th-arrow">{spansCtrl.sort.key === "duration" ? (spansCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                        <th {...spansCtrl.sortHeaderProps("start")}>Start <span className="sortable-th-arrow">{spansCtrl.sort.key === "start" ? (spansCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {spansCtrl.rows.map((span, index) => {
                        const key = spansCtrl.getRowKey(span, index);
                        const expanded = spansCtrl.isExpanded(key);
                        const openSpan = () => {
                          if (!expanded) spansCtrl.toggleExpanded(key);
                          setSelectedSpan(span);
                        };
                        return (
                          <tr
                            key={span.spanId}
                            className="data-row-clickable"
                            onClick={openSpan}
                            style={{ background: selectedSpan?.spanId === span.spanId ? "color-mix(in oklch, var(--accent) 10%, transparent)" : undefined }}
                          >
                            <td className="expander-col">
                              <button
                                type="button"
                                className="table-expander"
                                aria-label="Open span detail"
                                aria-expanded={expanded}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openSpan();
                                }}
                              >
                                <ChevronRight size={15} />
                              </button>
                            </td>
                            <td className="mono cell-ellipsis" title={span.traceId}>{span.traceId.slice(0, 8)}</td>
                            <td><span style={{ background: kindColor(span.kind), color: "#fff", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 600 }}>{span.kind}</span></td>
                            <td>{statusPill(span.status)}</td>
                            <td className="mono">{durMs(span)}</td>
                            <td className="mono cell-ellipsis">{fmtTs(span.startMs)} UTC</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  );
}
