import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ShieldCheck, AlertTriangle, CheckCircle2, RefreshCw, Sparkles,
  ArrowUpRight, Activity, BarChart2, Lock, ClipboardList, Search,
} from "lucide-react";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";

// ── Types ──────────────────────────────────────────────────────────────────

type HealthDriver = { label: string; impact: number; link: string; filterKey?: string };
type TrendPoint = { ts: number; score: number };
type AdminEventMarker = {
  id: string;
  ts: number;
  type: "deployment" | "config" | "incident";
  label: string;
  href: string;
  severity: "info" | "success" | "warning" | "critical";
};

type AdminHealth = {
  score: number;
  openCritical: number;
  openHigh: number;
  openMedium: number;
  productHealthFails: number;
  trustScore: number;
  stalePenalty: number;
  drivers: HealthDriver[];
  trend: TrendPoint[];
  computedAt: number;
};

type AutoFixRow = {
  id: number;
  ts: number;
  targetId: string | null;
  result: string | null;
  resultStatus: string | null;
  rollbackHint: string | null;
  risk: string | null;
  request: unknown;
};

type AdminEventsResponse = {
  events: AdminEventMarker[];
  degraded: boolean;
};

// ── Gauge ──────────────────────────────────────────────────────────────────

function ScoreGauge({ score, onClick }: { score: number; onClick?: () => void }) {
  const radius = 44;
  const circ = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const color = score >= 80 ? "#22c55e" : score >= 55 ? "#f59e0b" : "#ef4444";
  const dash = pct * circ;
  const gap = circ - dash;

  return (
    <button
      type="button"
      className="admin-gauge-btn"
      onClick={onClick}
      title="Click to filter inbox to score drivers"
      style={{ background: "none", border: "none", cursor: onClick ? "pointer" : "default", padding: 0 }}
    >
      <svg viewBox="0 0 100 100" width={100} height={100} style={{ overflow: "visible" }}>
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--muted-border)" strokeWidth={8} />
        <circle
          cx="50" cy="50" r={radius}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeDasharray={`${dash} ${gap}`}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
        <text x="50" y="54" textAnchor="middle" style={{ fontSize: 20, fontWeight: 700, fill: color, fontFamily: "inherit" }}>
          {score}
        </text>
      </svg>
    </button>
  );
}

// ── Trend sparkline ─────────────────────────────────────────────────────────

function eventMarkerGlyph(type: AdminEventMarker["type"]): string {
  if (type === "deployment") return "D";
  if (type === "config") return "C";
  return "I";
}

function TrendSparkline({ points, markers = [] }: { points: TrendPoint[]; markers?: AdminEventMarker[] }) {
  if (points.length < 2) return <span className="dim" style={{ fontSize: 11 }}>Not enough data for trend</span>;
  const w = 120, h = 30;
  const scores = points.map((p) => p.score);
  const minS = Math.min(...scores), maxS = Math.max(...scores);
  const range = maxS - minS || 1;
  const minTs = Math.min(...points.map((p) => p.ts));
  const maxTs = Math.max(...points.map((p) => p.ts));
  const tsRange = maxTs - minTs || 1;
  const visibleMarkers = markers
    .filter((marker) => marker.ts >= minTs && marker.ts <= maxTs)
    .slice(0, 12);
  const pts = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p.score - minS) / range) * h;
    return `${x},${y}`;
  });
  return (
    <div className="admin-trend-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} style={{ overflow: "visible" }} aria-label="Admin health trend">
        <polyline points={pts.join(" ")} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      {visibleMarkers.map((marker, index) => {
        const left = Math.max(4, Math.min(96, ((marker.ts - minTs) / tsRange) * 100));
        const top = 5 + (index % 3) * 9;
        return (
          <Link
            key={marker.id}
            href={marker.href}
            className={`admin-trend-marker ${marker.type} ${marker.severity}`}
            style={{ left: `${left}%`, top }}
            title={`${marker.type}: ${marker.label} - ${new Date(marker.ts).toLocaleString()}`}
          >
            {eventMarkerGlyph(marker.type)}
          </Link>
        );
      })}
    </div>
  );
}

// ── Admin Center Tab Bar ────────────────────────────────────────────────────

export function AdminCenterTabs({ active }: { active: string }) {
  const tabs = [
    { href: "/admin", label: "Overview" },
    { href: "/insights", label: "Detections" },
    { href: "/security", label: "Security" },
    { href: "/governance", label: "Access" },
    { href: "/compliance", label: "Compliance" },
    { href: "/audit", label: "Audit" },
  ];
  return (
    <nav className="admin-tabs" aria-label="Admin Center sections">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`admin-tab${active === t.href ? " active" : ""}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

// ── Auto-fix activity feed ──────────────────────────────────────────────────

function AutoFixFeed() {
  const { data, loading } = useApi<{ feed: AutoFixRow[]; degraded: boolean }>("/api/admin/autofixes", 30_000);
  const [reverting, setReverting] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function revert(row: AutoFixRow) {
    if (!row.rollbackHint) return;
    setReverting(row.id);
    setMessage(null);
    try {
      const res = await authFetch("/api/actions/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: row.rollbackHint, reason: "Operator revert via Admin Center", confirmed: true, params: {} }),
      });
      const json = await res.json().catch(() => ({})) as { data?: { message?: string }; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Revert failed");
      setMessage(json.data?.message ?? "Reverted.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Revert could not be completed.");
    } finally {
      setReverting(null);
    }
  }

  if (loading && !data) return <div className="loading-panel">Loading auto-fix activity…</div>;
  const feed = data?.feed ?? [];

  return (
    <div className="admin-autofixes">
      {message && <div className="insights-message"><CheckCircle2 size={14} />{message}</div>}
      {feed.length === 0 ? (
        <div className="empty-state">
          <CheckCircle2 size={20} />
          <span>No auto-fixes recorded yet.</span>
        </div>
      ) : (
        <div className="admin-autofix-list">
          {feed.map((row) => {
            const req = (row.request as Record<string, unknown>) ?? {};
            const sourceKey = typeof req.sourceKey === "string" ? req.sourceKey : null;
            return (
              <div key={row.id} className={`admin-autofix-row ${row.resultStatus === "success" ? "ok" : "err"}`}>
                <div className="admin-autofix-meta">
                  <span className={`pill ${row.resultStatus === "success" ? "green" : "red"}`}>{row.resultStatus ?? "?"}</span>
                  <span className="dim">{new Date(row.ts).toLocaleString()}</span>
                  {sourceKey && (
                    <Link href={`/insights?focus=${encodeURIComponent(sourceKey)}`} className="pill blue">
                      {sourceKey}
                    </Link>
                  )}
                </div>
                <p className="admin-autofix-result">{row.result ?? "—"}</p>
                {row.rollbackHint && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={reverting === row.id}
                    onClick={() => revert(row)}
                  >
                    <RefreshCw size={13} />
                    {reverting === row.id ? "Reverting…" : "Revert"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main AdminPage ──────────────────────────────────────────────────────────

export function AdminPage() {
  const [, navigate] = useLocation();
  const { data, loading, error, refresh } = useApi<AdminHealth>("/api/admin/health", 60_000);
  const eventsApi = useApi<AdminEventsResponse>("/api/admin/events?days=7", 60_000);
  const [briefing, setBriefing] = useState<{ text: string; model: string } | null>(null);
  const briefingFetched = useRef(false);

  useEffect(() => {
    if (briefingFetched.current) return;
    briefingFetched.current = true;
    authFetch("/api/admin/briefing")
      .then((r) => r.json() as Promise<{ data?: { briefing?: { text: string; model: string } | null } }>)
      .then((d) => { if (d.data?.briefing) setBriefing(d.data.briefing); })
      .catch(() => {});
  }, []);

  function goToScoreDrivers() {
    navigate("/insights");
  }

  const score = data?.score ?? null;
  const scoreColor = score === null ? "gray" : score >= 80 ? "green" : score >= 55 ? "amber" : "red";
  const critCount = data?.openCritical ?? 0;

  return (
    <div className="dash-page admin-page">
      {/* ── Header ── */}
      <section className="admin-hero">
        <div className="admin-hero-left">
          <div className="dash-section-title">admin center</div>
          <h1>Operations &amp; Governance</h1>
          <p>One health score, one inbox, one audit trail.</p>
        </div>
        <div className="admin-hero-right">
          {score !== null ? (
            <>
              <ScoreGauge score={score} onClick={goToScoreDrivers} />
              <div className="admin-gauge-meta">
                <span className={`pill ${scoreColor}`}>Health {score}/100</span>
                {critCount > 0 && (
                  <Link href="/insights?status=open&severity=critical" className="pill red">
                    {critCount} critical
                  </Link>
                )}
                <button type="button" className="btn btn-ghost" onClick={refresh}>
                  <RefreshCw size={13} />
                </button>
              </div>
              <TrendSparkline points={data?.trend ?? []} markers={eventsApi.data?.events ?? []} />
            </>
          ) : loading ? (
            <div className="loading-panel" style={{ minHeight: 0, padding: "8px 12px" }}>Computing score…</div>
          ) : (
            <div className="dim">{error ?? "Score unavailable"}</div>
          )}
        </div>
      </section>

      {/* ── AI State of the Stack ── */}
      {briefing && (
        <section className="admin-briefing dash-section">
          <div className="dash-section-title">
            <Sparkles size={13} />
            state of the stack
          </div>
          <p className="admin-briefing-text">{briefing.text}</p>
          <span className="dim" style={{ fontSize: 11 }}>via {briefing.model}</span>
        </section>
      )}

      {/* ── Score drivers ── */}
      {(data?.drivers ?? []).length > 0 && (
        <section className="dash-section admin-drivers">
          <div className="dash-section-title">score drivers</div>
          <div className="admin-drivers-list">
            {(data?.drivers ?? []).map((d) => (
              <Link key={d.label} href={d.link} className="admin-driver-card">
                <AlertTriangle size={14} />
                <span className="admin-driver-label">{d.label}</span>
                <span className="pill red">{d.impact}</span>
                <ArrowUpRight size={13} className="dim" />
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ── Admin Center Tabs ── */}
      <AdminCenterTabs active="/admin" />

      {/* ── Module status cards ── */}
      <section className="dash-section admin-modules">
        <div className="dash-section-title">admin sections</div>
        <div className="widget-grid">
          <Link href="/insights" className="wcard admin-mod-card">
            <div className="w-label"><Search size={13} /> Detections &amp; Auto-fix</div>
            <div className="w-headline sm">
              {data ? `${data.openCritical + data.openHigh} high+ open` : "—"}
            </div>
            <div className="w-caption">AI-reasoned findings, risk-tiered remediations</div>
            {critCount > 0 && <span className="pill red">{critCount} critical</span>}
          </Link>
          <Link href="/security" className="wcard admin-mod-card">
            <div className="w-label"><ShieldCheck size={13} /> Security</div>
            <div className="w-headline sm">
              {data ? `Trust ${data.trustScore}/100` : "—"}
            </div>
            <div className="w-caption">Posture, trust score, vulnerabilities</div>
          </Link>
          <Link href="/governance" className="wcard admin-mod-card">
            <div className="w-label"><Lock size={13} /> Access &amp; Policy</div>
            <div className="w-headline sm">RBAC · Budgets · Secrets</div>
            <div className="w-caption">Access control, policy, approvals</div>
          </Link>
          <Link href="/compliance" className="wcard admin-mod-card">
            <div className="w-label"><ClipboardList size={13} /> Compliance</div>
            <div className="w-headline sm">Control mapping</div>
            <div className="w-caption">DPA controls, evidence chain</div>
          </Link>
          <Link href="/audit" className="wcard admin-mod-card">
            <div className="w-label"><Activity size={13} /> Audit</div>
            <div className="w-headline sm">Action audit trail</div>
            <div className="w-caption">Tamper-evident operator + system log</div>
          </Link>
          <Link href="/incidents" className="wcard admin-mod-card">
            <div className="w-label"><AlertTriangle size={13} /> Incidents</div>
            <div className="w-headline sm">Cross-cutting failures</div>
            <div className="w-caption">Active incidents, timeline, resolution</div>
          </Link>
        </div>
      </section>

      {/* ── Auto-fix activity feed ── */}
      <section className="dash-section">
        <div className="dash-section-title">
          <BarChart2 size={13} />
          auto-fix activity
        </div>
        <AutoFixFeed />
      </section>
    </div>
  );
}
