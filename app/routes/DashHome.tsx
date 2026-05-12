import { Link } from "wouter";
import { useApi, fmtAge, fmtMs } from "../hooks/useApi";
import { useStream } from "../hooks/useStream";
import type { HomeData } from "../../server/api/types";
import { BarChart, Bar, ResponsiveContainer, Tooltip, Cell } from "recharts";
import { AnimatedNumber, AreaSparkline, Gauge, LiveTick, PipelineFlowBar } from "../components/AnimatedCharts";

interface MissionControlData {
  nowCard: {
    posture: "ok" | "warn" | "critical";
    summary: string;
    sources: string[];
  };
  decisionQueue: Array<{
    id: string;
    severity: "info" | "warn" | "critical";
    title: string;
    description: string;
    ageMs: number;
    action?: string;
    actionId?: string;
    sourceRoute?: string;
  }>;
  changeSinceLastVisit: {
    lastVisitTs: number | null;
    newArticles: number;
    queueDelta: number;
    newIncidents: number;
    modelsChanged: number;
    vastRunwayDeltaHours: number | null;
  } | null;
  nextBestActions: Array<{
    id: string;
    label: string;
    description: string;
    risk: "low" | "medium" | "high";
    targetRoute?: string;
  }>;
  riskStrip: Array<{
    kind: "runway" | "stale_telemetry" | "failed_check" | "incident" | "disk" | "queue";
    label: string;
    severity: "ok" | "warn" | "critical";
    value?: string;
  }>;
}

function MissionControlDeck() {
  const { data, loading, error } = useApi<MissionControlData>("/api/mission-control", 60_000);

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">…</div>;
  if (!data) return null;

  const d = data;

  const postureColor = d.nowCard.posture === "ok" ? "var(--green)" : d.nowCard.posture === "warn" ? "var(--amber)" : "var(--red)";

  return (
    <div className="dash-section">
      {/* Now Card */}
      <div style={{ padding: "12px 16px", background: `${postureColor}15`, borderLeft: `4px solid ${postureColor}`, marginBottom: 12, borderRadius: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: postureColor }} />
          <span className="w-label">Now</span>
        </div>
        <div style={{ marginTop: 8, fontSize: 14 }}>{d.nowCard.summary}</div>
        {d.decisionQueue[0]?.sourceRoute && (
          <Link href={d.decisionQueue[0].sourceRoute} className="btn btn-ghost" style={{ marginTop: 8, padding: "4px 8px", fontSize: 11 }}>
            → Go
          </Link>
        )}
      </div>

      {/* Decision Queue */}
      {d.decisionQueue.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="w-label" style={{ marginBottom: 6 }}>Decision queue</div>
          {d.decisionQueue.slice(0, 5).map((item) => (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, padding: "4px 8px", background: "var(--bg-sub)", borderRadius: 3 }}>
              <span className={`pill ${item.severity === "critical" ? "red" : item.severity === "warn" ? "amber" : "gray"}`} style={{ fontSize: 9 }}>
                {item.severity}
              </span>
              <span style={{ flex: 1, fontSize: 12 }}>{item.title}</span>
              {item.sourceRoute && (
                <Link href={item.sourceRoute} style={{ fontSize: 10, color: "var(--accent)" }}>→ Go</Link>
              )}
            </div>
          ))}
          {d.decisionQueue.length > 5 && (
            <div className="w-caption">+ {d.decisionQueue.length - 5} more</div>
          )}
        </div>
      )}

      {/* Next Best Actions */}
      {d.nextBestActions.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="w-label" style={{ marginBottom: 6 }}>Next actions</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {d.nextBestActions.map((action) => (
              action.targetRoute ? (
                <Link key={action.id} href={action.targetRoute} className="pill green" style={{ fontSize: 11, cursor: "pointer" }}>
                  {action.label}
                </Link>
              ) : (
                <span key={action.id} className="pill gray" style={{ fontSize: 11 }}>{action.label}</span>
              )
            ))}
          </div>
        </div>
      )}

      {/* Risk Strip */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {d.riskStrip.map((item) => {
            const dotColor = item.severity === "ok" ? "var(--green)" : item.severity === "warn" ? "var(--amber)" : "var(--red)";
            return (
              <span key={item.kind} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }} />
                <span>{item.label}</span>
                {item.value && <span className="dim">{item.value}</span>}
              </span>
            );
          })}
        </div>
      </div>

      {/* Change Since Last Visit */}
      {d.changeSinceLastVisit && d.changeSinceLastVisit.lastVisitTs !== null && (
        <div className="w-caption" style={{ color: "var(--text-dim)", fontSize: 11 }}>
          Since last visit: {d.changeSinceLastVisit.newArticles > 0 ? `+${d.changeSinceLastVisit.newArticles} articles` : `${d.changeSinceLastVisit.newArticles} articles`}
          {d.changeSinceLastVisit.queueDelta !== 0 && `, ${d.changeSinceLastVisit.queueDelta > 0 ? "+" : ""}${d.changeSinceLastVisit.queueDelta} queue`}
          {d.changeSinceLastVisit.newIncidents > 0 && `, ${d.changeSinceLastVisit.newIncidents} incidents`}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const cls = status === "active" ? "active" : status === "failed" ? "failed" : status === "inactive" ? "inactive" : "unknown";
  return <span className={`svc-pill ${cls}`}><span className="dot" />{status === "active" ? "" : ""}</span>;
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: "green" | "red" | "amber" | "gray" | "blue" }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function WCard({ href, children, className = "" }: { href?: string; children: React.ReactNode; className?: string }) {
  if (href) {
    return <Link href={href} className={`w-card ${className}`}>{children}</Link>;
  }
  return <div className={`w-card ${className}`}>{children}</div>;
}

function SparkBars({ values }: { values: number[] }) {
  return (
    <AreaSparkline values={values} height={40} gradientId="sparkline-home" />
  );
}

export function DashHome() {
  const { data: streamData, connected } = useStream<HomeData>("/api/stream");
  // Fallback poll for initial load if SSE hasn't fired yet
  const { data: pollData, loading, error } = useApi<HomeData>("/api/home", 60_000);
  const data = streamData ?? pollData;

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">failed to load: {error}</div>;
  if (!data) return null;

  const d = data;

  // GPU pill color
  const gpuColor = d.gpu.status === "up" ? "green" : d.gpu.status === "down" ? "red" : "amber";

  // Autopipeline color
  const pipeColor = d.autopipeline.paused ? "amber" : "green";

  // Doctor success rate
  const doctorRate = d.doctor.last24h.total > 0
    ? Math.round((d.doctor.last24h.success / d.doctor.last24h.total) * 100)
    : null;

  // Model quality summary
  const qualityProblems = d.models.qualitySummary.blocked + d.models.qualitySummary.degraded + d.models.qualitySummary.probation;

  return (
    <div className="dash-page">

      {/* ── Mission Control deck ────────────────────────── */}
      <MissionControlDeck />

      {/* ── Stack health ─────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-title">stack health</div>
        <WCard href="/infra" className="full">
          <div className="w-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            services
            <span className={`sse-dot${connected ? "" : " disconnected"}`} title={connected ? "live" : "polling"} />
          </div>
          <div className="service-strip">
            {d.services.map((s) => (
              <span key={s.name} className={`svc-pill ${s.status}`}>
                <span className="dot" />
                {s.name}
              </span>
            ))}
          </div>
        </WCard>

        <div className="widget-grid" style={{ marginTop: 8 }}>
          <WCard href="/infra#gpu">
            <div className="w-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              gpu <Pill color={gpuColor}>{d.gpu.status}</Pill>
            </div>
            {d.gpu.gpuUtil !== null ? (
              <Gauge pct={d.gpu.gpuUtil} label="utilization" />
            ) : (
              <div className="w-caption" style={{ marginTop: 6 }}>util not available</div>
            )}
            {d.gpu.loadedModels.length > 0 && (
              <div className="w-caption" style={{ marginTop: 4 }}>
                {d.gpu.loadedModels.join(", ")}
              </div>
            )}
            <div className="w-caption">{fmtAge(d.gpu.checkedAgo)}</div>
          </WCard>

          <WCard href="/infra#vast">
            <div className="w-label">vast balance</div>
            <div className="w-headline sm">
              {d.vast.balance !== null ? `$${((d.vast.balance ?? 0) + (d.vast.credit ?? 0)).toFixed(2)}` : "—"}
            </div>
            {d.vast.runwayHours !== null && (
              <div className="w-caption">{d.vast.runwayHours}h runway · ${d.vast.hourlyRate}/hr</div>
            )}
            {d.vast.instanceStatus && (
              <div className="w-row" style={{ marginTop: 6 }}>
                <Pill color={d.vast.instanceStatus === "running" ? "green" : "amber"}>{d.vast.instanceStatus}</Pill>
                {d.vast.gpu && <span className="w-caption">{d.vast.gpu}</span>}
              </div>
            )}
          </WCard>

          <WCard href="/infra#hetzner">
            <div className="w-label">hetzner</div>
            <div className="w-row">
              <span className="w-caption">RAM {d.hetzner.memUsedPct}%</span>
              <span className="w-caption">Disk {d.hetzner.diskUsedPct}%</span>
            </div>
            <div className="w-caption">load {d.hetzner.load1.toFixed(2)} / {d.hetzner.load5.toFixed(2)} / {d.hetzner.load15.toFixed(2)}</div>
          </WCard>
        </div>
      </div>

      {/* ── NewsBites ─────────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-title">newsbites</div>
        <div className="widget-grid">
          <WCard href="/newsbites">
            <div className="w-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              total published <LiveTick live={connected ?? false} />
            </div>
            <div className="w-headline"><AnimatedNumber value={d.newsbites.totalPublished} /></div>
            <div className="w-caption">+{d.newsbites.publishedToday} today</div>
          </WCard>

          <WCard href="/newsbites#publish-rate">
            <div className="w-label">7d publish rate</div>
            <SparkBars values={d.newsbites.publishedLast7d} />
            <div className="w-caption">{d.newsbites.publishedLast7d.reduce((a, b) => a + b, 0)} this week</div>
          </WCard>

          <WCard href="/newsbites#by-vertical">
            <div className="w-label">top verticals</div>
            {d.newsbites.topVerticals.slice(0, 4).map((v) => (
              <div key={v.vertical} className="w-row" style={{ marginBottom: 2 }}>
                <span className="w-caption" style={{ flex: 1 }}>{v.vertical}</span>
                <span className="w-caption">{v.count}</span>
              </div>
            ))}
          </WCard>

          <WCard href="/newsbites">
            <div className="w-label">latest published</div>
            {d.newsbites.latestArticles.map((a) => (
              <div key={a.slug} style={{ marginBottom: 5 }}>
                <div style={{ fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>{a.vertical} · {a.date}</div>
              </div>
            ))}
            <div className="w-row">
              <Pill color={d.newsbites.siteReachable ? "green" : "red"}>{d.newsbites.siteReachable ? "site up" : "site down"}</Pill>
            </div>
          </WCard>
        </div>
      </div>

      {/* ── Autopipeline ──────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-title">autopipeline</div>
        <div className="widget-grid">
          <WCard href="/autopipeline#queue">
            <div className="w-label">queue depth</div>
            <div className="w-headline"><AnimatedNumber value={d.autopipeline.queueDepth} /></div>
            <PipelineFlowBar stages={[
              { name: "scout",    count: d.autopipeline.stageBreakdown["scout"]    ?? 0 },
              { name: "research", count: d.autopipeline.stageBreakdown["research"] ?? 0, hot: (d.autopipeline.stageBreakdown["research"] ?? 0) > 0 },
              { name: "write",    count: d.autopipeline.stageBreakdown["write"]    ?? 0, hot: (d.autopipeline.stageBreakdown["write"]    ?? 0) > 0 },
              { name: "verify",   count: d.autopipeline.stageBreakdown["verify"]   ?? 0 },
              { name: "publish",  count: d.autopipeline.stageBreakdown["publish"]  ?? 0, warn: (d.autopipeline.stageBreakdown["publish"]  ?? 0) > 0 },
            ]} />
          </WCard>

          <WCard href="/autopipeline#current">
            <div className="w-label">current story</div>
            {d.autopipeline.currentStory ? (
              <>
                <div className="w-headline xs" style={{ marginBottom: 4 }}>
                  {d.autopipeline.currentStory.slug ?? d.autopipeline.currentStory.id}
                </div>
                <Pill color="amber">{d.autopipeline.currentStory.stage}</Pill>
              </>
            ) : (
              <div className="w-caption">idle</div>
            )}
          </WCard>

          <WCard href="/autopipeline#approvals">
            <div className="w-label">approvals waiting</div>
            <div className="w-headline">{d.autopipeline.approvalsWaiting}</div>
            {d.autopipeline.oldestApprovalAgeMs && (
              <div className="w-caption">oldest {fmtMs(d.autopipeline.oldestApprovalAgeMs)}</div>
            )}
          </WCard>

          <WCard href="/autopipeline">
            <div className="w-label">pause state</div>
            <div className="w-row">
              <Pill color={pipeColor}>{d.autopipeline.paused ? "paused" : "running"}</Pill>
            </div>
            {d.autopipeline.pauseReason && (
              <div className="w-caption">{d.autopipeline.pauseReason}</div>
            )}
          </WCard>
        </div>
      </div>

      {/* ── Doctor ────────────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-title">doctor</div>
        <div className="widget-grid">
          <WCard href="/doctor">
            <div className="w-label">repairs 24h</div>
            <div className="w-headline">{d.doctor.last24h.total}</div>
            {doctorRate !== null && (
              <div className="w-caption">{doctorRate}% success</div>
            )}
          </WCard>

          <WCard href="/doctor#errors">
            <div className="w-label">top error classes</div>
            {d.doctor.last24h.errorClasses.slice(0, 3).map((e) => (
              <div key={e.type} className="w-row" style={{ marginBottom: 2 }}>
                <span className="w-caption" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.type}</span>
                <span className="w-caption">{e.count}</span>
              </div>
            ))}
            {d.doctor.last24h.errorClasses.length === 0 && <div className="w-caption">none</div>}
          </WCard>

          <WCard href="/doctor#models">
            <div className="w-label">top failing models</div>
            {d.doctor.last24h.topFailingModels.slice(0, 3).map((m) => (
              <div key={m.model} className="w-row" style={{ marginBottom: 2 }}>
                <span className="w-caption" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.model}</span>
                <span className="w-caption">{m.count}</span>
              </div>
            ))}
            {d.doctor.last24h.topFailingModels.length === 0 && <div className="w-caption">none</div>}
          </WCard>

          <WCard href="/doctor#verdicts">
            <div className="w-label">verdict mix</div>
            {d.doctor.last24h.verdictMix.slice(0, 4).map((v) => (
              <div key={v.action} className="w-row" style={{ marginBottom: 2 }}>
                <span className="w-caption" style={{ flex: 1 }}>{v.action}</span>
                <span className="w-caption">{v.count}</span>
              </div>
            ))}
            {d.doctor.last24h.verdictMix.length === 0 && <div className="w-caption">none</div>}
          </WCard>
        </div>
      </div>

      {/* ── Models ────────────────────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-title">models</div>
        <div className="widget-grid">
          <WCard href="/models#current">
            <div className="w-label">best right now</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
              {d.models.bestCloudHeavy && (
                <div className="w-row">
                  <span className="pill gray" style={{ fontSize: 9 }}>heavy</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}>{d.models.bestCloudHeavy}</span>
                </div>
              )}
              {d.models.bestCloudFast && (
                <div className="w-row">
                  <span className="pill gray" style={{ fontSize: 9 }}>fast</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>{d.models.bestCloudFast}</span>
                </div>
              )}
              {d.models.bestLocal && (
                <div className="w-row">
                  <span className="pill gray" style={{ fontSize: 9 }}>local</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>{d.models.bestLocal}</span>
                </div>
              )}
            </div>
          </WCard>

          <WCard href="/models#by-capability">
            <div className="w-label">available models</div>
            <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
              <div>
                <div className="w-headline sm">{d.models.availableByCapability.heavy}</div>
                <div className="w-caption">heavy</div>
              </div>
              <div>
                <div className="w-headline sm">{d.models.availableByCapability.medium}</div>
                <div className="w-caption">medium</div>
              </div>
              <div>
                <div className="w-headline sm">{d.models.availableByCapability.light}</div>
                <div className="w-caption">light</div>
              </div>
            </div>
          </WCard>

          <WCard href="/models#quality">
            <div className="w-label">quality flags</div>
            <div className="w-row" style={{ flexWrap: "wrap", gap: 4, marginTop: 4 }}>
              {d.models.qualitySummary.blocked > 0 && <Pill color="red">blocked {d.models.qualitySummary.blocked}</Pill>}
              {d.models.qualitySummary.degraded > 0 && <Pill color="amber">degraded {d.models.qualitySummary.degraded}</Pill>}
              {d.models.qualitySummary.probation > 0 && <Pill color="amber">probation {d.models.qualitySummary.probation}</Pill>}
              {qualityProblems === 0 && <Pill color="green">all clear</Pill>}
            </div>
          </WCard>

          <WCard href="/models#new">
            <div className="w-label">discovery</div>
            {d.models.newModelsAdded.length > 0 ? (
              <>
                <div className="w-headline sm">{d.models.newModelsAdded.length}</div>
                <div className="w-caption">new in last check</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                  {d.models.newModelsAdded.slice(0, 2).join(", ")}
                  {d.models.newModelsAdded.length > 2 && ` +${d.models.newModelsAdded.length - 2}`}
                </div>
              </>
            ) : (
              <div className="w-caption">no new models in last check</div>
            )}
            <div className="w-caption">
              {d.models.lastFullCheckAgo > 0 ? `full check ${fmtAge(d.models.lastFullCheckAgo)}` : ""}
            </div>
          </WCard>

          {d.models.cooldownsActive > 0 && (
            <WCard href="/models#cooldowns">
              <div className="w-label">cooldowns active</div>
              <div className="w-headline sm">{d.models.cooldownsActive}</div>
              {d.models.soonestCooldownExpiresMs && (
                <div className="w-caption">soonest expires {fmtMs(d.models.soonestCooldownExpiresMs - Date.now())}</div>
              )}
            </WCard>
          )}
        </div>
      </div>

      {/* ── OpenCode + Incidents ─────────────────────── */}
      <div className="dash-section">
        <div className="dash-section-title">opencode · incidents</div>
        <div className="widget-grid">
          <WCard href="/opencode">
            <div className="w-label">opencode</div>
            <div className="w-row">
              <Pill color="blue">open chat →</Pill>
            </div>
            <div className="w-caption" style={{ marginTop: 6 }}>existing session UI</div>
          </WCard>

          <WCard href="/incidents">
            <div className="w-label">active incidents</div>
            <div className="w-headline sm">{d.incidents.activeCount}</div>
            {d.incidents.recentAlerts.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {d.incidents.recentAlerts.slice(0, 3).map((a) => (
                  <div key={a.key} style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginBottom: 2 }}>
                    {a.key}
                  </div>
                ))}
              </div>
            )}
          </WCard>
        </div>
      </div>

    </div>
  );
}
