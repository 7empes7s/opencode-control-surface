import { Link } from "wouter";
import { useApi, fmtAge } from "../hooks/useApi";

interface TodayData {
  date: string;
  overnightSummary: {
    eventsCount: number;
    topEvents: Array<{ title: string; severity: string; source: string }>;
    newArticles: number;
    serviceRestarts: number;
  };
  publishingSummary: {
    publishedToday: number;
    pendingApproval: number;
    failed: number;
    topCandidates: Array<{ slug: string; vertical: string; stage: string }>;
  };
  modelSummary: {
    bestAvailable: string[];
    degraded: string[];
    blocked: string[];
    newlyDiscovered: string[];
  };
  infraSummary: {
    gpuStatus: string;
    vastRunwayHours: number | null;
    serviceIssues: string[];
    recentRestarts: Array<{ name: string; restartedAt?: number }>;
  };
  costSummary: {
    vastBalanceUsd: number | null;
    estimatedDailyBurnUsd: number | null;
    projectedMonthlyUsd: number | null;
    note: string;
  };
  suggestedSchedule: Array<{
    order: number;
    task: string;
    reason: string;
    targetRoute?: string;
  }>;
}

function WCard({ href, children, className = "" }: { href?: string; children: React.ReactNode; className?: string }) {
  if (href) {
    return <Link href={href} className={`w-card ${className}`}>{children}</Link>;
  }
  return <div className={`w-card ${className}`}>{children}</div>;
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: "green" | "red" | "amber" | "gray" | "blue" }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

export function TodayPage() {
  const { data, loading, error } = useApi<TodayData>("/api/today", 60_000);

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">failed to load: {error}</div>;
  if (!data) return null;

  const d = data;

  return (
    <div className="dash-page">
      {/* Header */}
      <div className="dash-section">
        <div className="dash-section-title">Today — {d.date}</div>
      </div>

      {/* Overnight Summary */}
      <div className="dash-section">
        <div className="dash-section-title">overnight summary</div>
        <div className="widget-grid">
          <WCard>
            <div className="w-label">events since midnight</div>
            <div className="w-headline">{d.overnightSummary.eventsCount}</div>
          </WCard>
          <WCard>
            <div className="w-label">new articles</div>
            <div className="w-headline">{d.overnightSummary.newArticles}</div>
          </WCard>
          <WCard>
            <div className="w-label">service restarts</div>
            <div className="w-headline">{d.overnightSummary.serviceRestarts}</div>
          </WCard>
        </div>
        {d.overnightSummary.topEvents.length > 0 && (
          <div className="w-caption" style={{ marginTop: 8 }}>
            {d.overnightSummary.topEvents.map((e, i) => (
              <div key={i} style={{ marginBottom: 2 }}>
                <Pill color={e.severity === "error" ? "red" : e.severity === "warn" ? "amber" : "gray"}>
                  {e.severity}
                </Pill>{" "}
                {e.title} <span className="dim">({e.source})</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Publishing Summary */}
      <div className="dash-section">
        <div className="dash-section-title">publishing</div>
        <div className="widget-grid">
          <WCard>
            <div className="w-label">published today</div>
            <div className="w-headline">{d.publishingSummary.publishedToday}</div>
          </WCard>
          <WCard href="/autopipeline">
            <div className="w-label">pending approval</div>
            <div className="w-headline">{d.publishingSummary.pendingApproval}</div>
          </WCard>
          <WCard>
            <div className="w-label">failed</div>
            <div className="w-headline">{d.publishingSummary.failed}</div>
          </WCard>
        </div>
        {d.publishingSummary.topCandidates.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="w-label">top candidates</div>
            {d.publishingSummary.topCandidates.map((c, i) => (
              <div key={i} className="w-row" style={{ marginTop: 4 }}>
                <span className="w-caption">{c.slug}</span>
                <Pill color="gray">{c.stage}</Pill>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Model Summary */}
      <div className="dash-section">
        <div className="dash-section-title">models</div>
        <div className="w-label">best available</div>
        <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          {d.modelSummary.bestAvailable.map((m, i) => (
            <Pill key={i} color="green">{m}</Pill>
          ))}
          {d.modelSummary.bestAvailable.length === 0 && <span className="w-caption">none</span>}
        </div>
        {d.modelSummary.degraded.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="w-label">degraded</div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              {d.modelSummary.degraded.map((_, i) => (
                <Pill key={i} color="amber">degraded</Pill>
              ))}
            </div>
          </div>
        )}
        {d.modelSummary.blocked.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="w-label">blocked</div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              {d.modelSummary.blocked.map((_, i) => (
                <Pill key={i} color="red">blocked</Pill>
              ))}
            </div>
          </div>
        )}
        {d.modelSummary.newlyDiscovered.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="w-label">newly discovered</div>
            <div className="w-caption">{d.modelSummary.newlyDiscovered.join(", ")}</div>
          </div>
        )}
      </div>

      {/* Infra Summary */}
      <div className="dash-section">
        <div className="dash-section-title">infrastructure</div>
        <div className="widget-grid">
          <WCard href="/infra">
            <div className="w-label">GPU status</div>
            <Pill color={d.infraSummary.gpuStatus === "up" ? "green" : d.infraSummary.gpuStatus === "down" ? "red" : "amber"}>
              {d.infraSummary.gpuStatus}
            </Pill>
          </WCard>
          <WCard href="/infra">
            <div className="w-label">Vast runway</div>
            <div className="w-headline sm">
              {d.infraSummary.vastRunwayHours !== null ? `${d.infraSummary.vastRunwayHours}h` : "—"}
            </div>
          </WCard>
        </div>
        {d.infraSummary.serviceIssues.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="w-label">service issues</div>
            {d.infraSummary.serviceIssues.map((issue, i) => (
              <div key={i} className="w-row" style={{ marginTop: 2 }}>
                <Pill color="red">{issue}</Pill>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cost Summary */}
      <div className="dash-section">
        <div className="dash-section-title">cost</div>
        <div className="widget-grid">
          <WCard>
            <div className="w-label">Vast balance</div>
            <div className="w-headline">
              ${d.costSummary.vastBalanceUsd !== null ? d.costSummary.vastBalanceUsd.toFixed(2) : "—"}
            </div>
          </WCard>
          <WCard>
            <div className="w-label">daily burn</div>
            <div className="w-headline sm">
              ${d.costSummary.estimatedDailyBurnUsd !== null ? d.costSummary.estimatedDailyBurnUsd.toFixed(2) : "—"}
            </div>
          </WCard>
          <WCard>
            <div className="w-label">monthly projection</div>
            <div className="w-headline sm">
              ${d.costSummary.projectedMonthlyUsd !== null ? d.costSummary.projectedMonthlyUsd.toFixed(0) : "—"}
            </div>
          </WCard>
        </div>
        <div className="w-caption" style={{ marginTop: 8 }}>{d.costSummary.note}</div>
      </div>

      {/* Suggested Schedule */}
      <div className="dash-section">
        <div className="dash-section-title">suggested schedule</div>
        {d.suggestedSchedule.map((task) => (
          <div key={task.order} className="w-card" style={{ marginBottom: 8, padding: "12px" }}>
            <div className="w-row">
              <span className="w-label" style={{ width: 24 }}>#{task.order}</span>
              {task.targetRoute ? (
                <Link href={task.targetRoute} className="w-headline xs" style={{ flex: 1 }}>
                  {task.task} →
                </Link>
              ) : (
                <span className="w-headline xs" style={{ flex: 1 }}>{task.task}</span>
              )}
            </div>
            <div className="w-caption">{task.reason}</div>
          </div>
        ))}
        {d.suggestedSchedule.length === 0 && (
          <div className="w-caption">No tasks suggested - everything looks good!</div>
        )}
      </div>

      {/* Actions Bar */}
      <div className="dash-section">
        <div className="dash-section-title">actions</div>
        <div className="action-bar">
          <button className="btn btn-ghost" disabled title="coming in V4.1">
            Export to AI Vault
          </button>
          <button className="btn btn-ghost" disabled title="coming in V4.1">
            Generate Telegram brief
          </button>
        </div>
      </div>
    </div>
  );
}