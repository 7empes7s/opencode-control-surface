import { useState } from "react";
import type { AgentRun } from "../../server/api/types";

const PRE: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)",
  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 3,
  padding: "10px 12px", whiteSpace: "pre-wrap", overflow: "auto",
  maxHeight: 240, margin: "8px 0 0 0",
};

export function AgentRunList({ agentRuns }: { agentRuns: AgentRun[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((s) => ({ ...s, [id]: !s[id] }));

  if (agentRuns.length === 0) return <div className="loading-dim">No agent runs found</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {agentRuns.map((run) => (
        <div key={run.id} style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4 }}>
          <div
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", cursor: "pointer" }}
            onClick={() => toggle(run.id)}
          >
            <span className="pill gray" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{run.stage}</span>
            <span className="mono dim" style={{ fontSize: 11, flex: 1 }}>{run.startedAt || run.id}</span>
            <span className="mono dim" style={{ fontSize: 10 }}>{open[run.id] ? "▲" : "▼"}</span>
          </div>
          {open[run.id] && (
            <div style={{ padding: "0 14px 12px" }}>
              {Object.keys(run.metadata ?? {}).length > 0 && (
                <>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 8 }}>Metadata</div>
                  <pre style={PRE}>{JSON.stringify(run.metadata, null, 2)}</pre>
                </>
              )}
              {Object.keys(run.response ?? {}).length > 0 && (
                <>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 8 }}>Response</div>
                  <pre style={PRE}>{JSON.stringify(run.response, null, 2)}</pre>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
