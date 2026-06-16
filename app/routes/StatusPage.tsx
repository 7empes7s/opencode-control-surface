import { useEffect, useState } from "react";

type PublicStatusPayload = {
  status: "operational" | "degraded" | "down";
  score: number | null;
  checkedAt: string | null;
  uptimeSec: number;
  agents: Array<{ name: string; ok: boolean }>;
  services: Array<Record<string, never>>;
  generatedAt: string;
};

const STATUS_COPY: Record<PublicStatusPayload["status"], { headline: string; summary: string }> = {
  operational: {
    headline: "All systems operational.",
    summary: "Every check the platform runs is currently passing.",
  },
  degraded: {
    headline: "Partial degradation.",
    summary: "Some checks are below normal but the platform is still working.",
  },
  down: {
    headline: "Major outage.",
    summary: "Multiple critical checks are failing. The team has been notified.",
  },
};

function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatCheckedAt(iso: string | null): string {
  if (!iso) return "no recent check";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function StatusDot({ status }: { status: PublicStatusPayload["status"] }) {
  const color =
    status === "operational" ? "var(--green)" :
    status === "degraded" ? "var(--amber-warn)" :
    "var(--red)";
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 28,
        height: 28,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 0 6px color-mix(in oklch, ${color} 18%, transparent)`,
        flexShrink: 0,
      }}
    />
  );
}

function AgentChip({ name, ok }: { name: string; ok: boolean }) {
  const dotColor = ok ? "var(--green)" : "var(--red)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 999,
        background: "var(--bg-hover)",
        border: "1px solid var(--border)",
        fontSize: 12,
        color: "var(--text)",
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
      <span style={{ color: "var(--text-dim)", fontSize: 11, flexShrink: 0 }}>
        {ok ? "live" : "down"}
      </span>
    </span>
  );
}

export function StatusPage() {
  const [data, setData] = useState<PublicStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/public-status", { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as PublicStatusPayload;
        if (!cancelled) setData(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "unable to load status");
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (error) {
    return (
      <main style={pageStyle}>
        <div style={cardStyle}>
          <StatusDot status="down" />
          <h1 style={h1Style}>Status unavailable</h1>
          <p style={bodyStyle}>{error}</p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main style={pageStyle}>
        <div style={cardStyle}>
          <StatusDot status="degraded" />
          <h1 style={h1Style}>Checking the platform…</h1>
          <p style={bodyStyle}>One moment.</p>
        </div>
      </main>
    );
  }

  const copy = STATUS_COPY[data.status];

  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
          <StatusDot status={data.status} />
          <h1 style={{ ...h1Style, margin: 0 }}>{copy.headline}</h1>
        </div>
        <p style={{ ...bodyStyle, marginTop: 10 }}>{copy.summary}</p>

        <dl style={gridStyle}>
          <div style={cellStyle}>
            <dt style={dtStyle}>Health score</dt>
            <dd style={ddStyle}>{data.score == null ? "—" : `${data.score}/100`}</dd>
          </div>
          <div style={cellStyle}>
            <dt style={dtStyle}>Uptime</dt>
            <dd style={ddStyle}>{formatUptime(data.uptimeSec)}</dd>
          </div>
          <div style={{ ...cellStyle, gridColumn: "1 / -1" }}>
            <dt style={dtStyle}>Last check</dt>
            <dd style={{ ...ddStyle, fontSize: 13 }}>{formatCheckedAt(data.checkedAt)}</dd>
          </div>
        </dl>
      </div>

      {data.agents.length > 0 && (
        <div style={cardStyle}>
          <h2 style={h2Style}>Agent liveness</h2>
          <div style={chipRowStyle}>
            {data.agents.map((a) => (
              <AgentChip key={a.name} name={a.name} ok={a.ok} />
            ))}
          </div>
        </div>
      )}

      <footer style={footerStyle}>
        <span>Plain-English status. Updated every 30 seconds.</span>
        <span style={{ color: "var(--text-dim)" }}>control.techinsiderbytes.com</span>
      </footer>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  width: "100%",
  maxWidth: "100vw",
  overflowX: "hidden",
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--sans, system-ui, sans-serif)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "32px 20px",
  boxSizing: "border-box",
};

const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 560,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "24px 20px",
  boxSizing: "border-box",
  marginBottom: 16,
  minWidth: 0,
};

const h1Style: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  color: "var(--text-bright)",
  lineHeight: 1.3,
  wordBreak: "break-word",
};

const h2Style: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  margin: "0 0 12px 0",
};

const bodyStyle: React.CSSProperties = {
  fontSize: 14,
  color: "var(--text)",
  lineHeight: 1.55,
  margin: 0,
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 12,
  margin: "20px 0 0 0",
  width: "100%",
};

const cellStyle: React.CSSProperties = {
  background: "var(--bg-raised)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "12px 14px",
  minWidth: 0,
  boxSizing: "border-box",
};

const dtStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: 0.6,
  margin: 0,
};

const ddStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: "var(--text-bright)",
  margin: "4px 0 0 0",
  fontFamily: "var(--mono, monospace)",
  wordBreak: "break-word",
};

const chipRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  width: "100%",
};

const footerStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 560,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 11,
  color: "var(--text-dim)",
  marginTop: 8,
  flexWrap: "wrap",
  gap: 6,
  minWidth: 0,
};
