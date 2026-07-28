import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useApi, fmtAge } from "../hooks/useApi";
import { useStream } from "../hooks/useStream";
import type { HomeData } from "../../server/api/types";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { authFetch } from "../lib/authFetch";
import { AnimatedNumber, Dot, PostureRing, Reveal, Sparkline, Stat } from "../components/v5/ui";
import {
  AlertTriangle, ArrowUpRight, Cpu, GaugeCircle, Newspaper,
  Server, Sparkles, Stethoscope, Workflow, Zap,
} from "lucide-react";

const Scene3D = lazy(() => import("../components/v5/Scene3D"));

/* ─────────────────────────── data shapes ─────────────────────────── */

interface MissionControlData {
  nowCard: { posture: "ok" | "warn" | "critical"; summary: string; sources: string[] };
  decisionQueue: Array<{
    id: string; severity: "info" | "warn" | "critical"; title: string;
    description: string; ageMs: number; actionId?: string; sourceRoute?: string;
  }>;
  changeSinceLastVisit: {
    lastVisitTs: number | null; newArticles: number; queueDelta: number;
    newIncidents: number; modelsChanged: number; vastRunwayDeltaHours: number | null;
  } | null;
  nextBestActions: Array<{ id: string; label: string; description: string; risk: "low" | "medium" | "high"; targetRoute?: string }>;
  riskStrip: Array<{ kind: string; label: string; severity: "ok" | "warn" | "critical"; value?: string }>;
}

type AdminHealth = { score: number; openCritical: number; openHigh: number; openMedium: number };
type FindingPreview = { id: string; title: string; severity: string; sourceKey: string | null };

/* ─────────────────────────── hero ────────────────────────────────── */

function Hero({ d, mc }: { d: HomeData; mc: MissionControlData | null }) {
  const posture = mc?.nowCard.posture ?? "ok";
  const services = d.services ?? [];
  const up = services.filter((s) => s.status === "active").length;
  const pct = services.length > 0 ? Math.round((up / services.length) * 100) : 0;
  const tone = posture === "critical" ? "err" : posture === "warn" ? "warn" : "ok";

  return (
    <div className="v5-hero">
      <div className="v5-hero-canvas">
        <Suspense fallback={null}>
          <Scene3D />
        </Suspense>
      </div>
      <div className="v5-hero-inner">
        <div className="v5-hero-eyebrow">
          <Zap size={12} /> Mission control · live
        </div>
        <h1 className="v5-hero-title">
          Everything at a <span className="grad">glance</span>
        </h1>
        <p className="v5-hero-sub">
          {mc?.nowCard.summary ?? "Live telemetry across the whole TIB stack — services, pipeline, models, GPU and content."}
        </p>
        {mc && mc.riskStrip.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            {mc.riskStrip.map((r) => (
              <span key={r.kind} className={`v5-pill ${r.severity === "critical" ? "err" : r.severity === "warn" ? "warn" : "ok"}`}>
                <Dot tone={r.severity === "critical" ? "err" : r.severity === "warn" ? "warn" : "ok"} />
                {r.label}{r.value ? ` · ${r.value}` : ""}
              </span>
            ))}
          </div>
        )}
        {mc && mc.nextBestActions.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            {mc.nextBestActions.slice(0, 3).map((a) =>
              a.targetRoute ? (
                <Link key={a.id} href={a.targetRoute} className="v5-btn primary" style={{ minHeight: 34, padding: "6px 14px", fontSize: 12 }}>
                  {a.label} <ArrowUpRight size={13} />
                </Link>
              ) : (
                <span key={a.id} className="v5-pill info">{a.label}</span>
              )
            )}
          </div>
        )}
      </div>
      <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", padding: "24px clamp(18px,3vw,36px)" }}>
        <PostureRing pct={pct} tone={tone} label={`${pct}%`} sub={`${up}/${services.length} up`} />
      </div>
    </div>
  );
}

/* ─────────────────────────── decision queue ──────────────────────── */

function DecisionQueue({ mc }: { mc: MissionControlData }) {
  if (mc.decisionQueue.length === 0) return null;
  return (
    <div className="v5-section">
      <Reveal>
        <div className="v5-section-head">
          <div className="v5-section-title"><AlertTriangle size={15} style={{ color: "var(--amber-warn)" }} /> Decision queue</div>
        </div>
        <div className="v5-card flat-hover" style={{ padding: 8 }}>
          {mc.decisionQueue.slice(0, 5).map((item) => (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10 }}>
              <span className={`v5-pill ${item.severity === "critical" ? "err" : item.severity === "warn" ? "warn" : "info"}`}>{item.severity}</span>
              <span style={{ flex: 1, fontSize: 13 }}>{item.title}</span>
              {item.sourceRoute && <Link href={item.sourceRoute} className="v5-section-link">open →</Link>}
            </div>
          ))}
          {mc.decisionQueue.length > 5 && (
            <div style={{ padding: "4px 12px 8px", fontSize: 12, color: "var(--text-muted)" }}>+ {mc.decisionQueue.length - 5} more</div>
          )}
        </div>
      </Reveal>
    </div>
  );
}

/* ─────────────────────────── stat row ────────────────────────────── */

function StatRow({ d }: { d: HomeData }) {
  const services = d.services ?? [];
  const up = services.filter((s) => s.status === "active").length;
  const failed = services.filter((s) => s.status === "failed").length;
  const doctorRate = d.doctor.last24h.total > 0
    ? Math.round((d.doctor.last24h.success / d.doctor.last24h.total) * 100) : null;

  return (
    <div className="v5-section v5-grid stats">
      <Reveal delay={0.02}><Stat label="services up" value={<><AnimatedNumber value={up} /><span style={{ fontSize: 16, color: "var(--text-muted)" }}>/{services.length}</span></>} tone={failed > 0 ? "err" : "ok"} caption={failed > 0 ? `${failed} failed` : "all systems normal"} /></Reveal>
      <Reveal delay={0.06}><Stat label="pipeline queue" value={<AnimatedNumber value={d.autopipeline.queueDepth} />} tone={d.autopipeline.paused ? "warn" : "ok"} caption={d.autopipeline.paused ? "paused" : d.autopipeline.approvalsWaiting > 0 ? `${d.autopipeline.approvalsWaiting} awaiting approval` : "flowing"} /></Reveal>
      <Reveal delay={0.10}><Stat label="articles today" gradient value={<AnimatedNumber value={d.newsbites.publishedToday} />} caption={`${d.newsbites.totalPublished.toLocaleString()} all-time`} /></Reveal>
      <Reveal delay={0.14}><Stat label="gpu" value={d.gpu.gpuUtil !== null ? <AnimatedNumber value={d.gpu.gpuUtil} suffix="%" /> : "—"} tone={d.gpu.status === "up" ? "ok" : d.gpu.status === "down" ? "err" : "idle"} caption={d.gpu.status === "off" ? "operator off" : d.gpu.loadedModels.length > 0 ? `${d.gpu.loadedModels.length} models loaded` : d.gpu.status} /></Reveal>
      <Reveal delay={0.18}><Stat label="doctor 24h" value={doctorRate !== null ? <AnimatedNumber value={doctorRate} suffix="%" /> : "—"} tone={doctorRate === null ? "idle" : doctorRate >= 90 ? "ok" : doctorRate >= 70 ? "warn" : "err"} caption={`${d.doctor.last24h.total} interventions`} /></Reveal>
      <Reveal delay={0.22}><Stat label="incidents" value={<AnimatedNumber value={d.incidents.activeCount} />} tone={d.incidents.activeCount > 0 ? "err" : "ok"} caption={d.incidents.activeCount > 0 ? "active now" : "none active"} /></Reveal>
    </div>
  );
}

/* ─────────────────────────── service mesh ────────────────────────── */

function ServiceMesh({ d }: { d: HomeData }) {
  const services = d.services ?? [];
  return (
    <div className="v5-section">
      <Reveal>
        <div className="v5-section-head">
          <div className="v5-section-title"><Server size={15} style={{ color: "var(--accent)" }} /> Service mesh</div>
          <Link href="/infra" className="v5-section-link">infra →</Link>
        </div>
        <div className="v5-card flat-hover">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {services.map((s) => {
              const tone = s.status === "active" ? "ok" : s.status === "failed" ? "err" : s.status === "inactive" ? "idle" : "warn";
              return (
                <span key={s.name} className={`v5-pill ${tone === "idle" ? "" : tone}`} style={{ fontSize: 12, padding: "6px 13px" }}>
                  <Dot tone={tone} />
                  {s.name}
                </span>
              );
            })}
          </div>
        </div>
      </Reveal>
    </div>
  );
}

/* ─────────────────────────── editorial pulse ─────────────────────── */

function EditorialPulse({ d }: { d: HomeData }) {
  const nb = d.newsbites;
  const chart = nb.publishedLast7d.map((v, i) => ({ i, v }));
  return (
    <div className="v5-card flat-hover">
      <div className="v5-section-head" style={{ marginBottom: 12 }}>
        <div className="v5-section-title"><Newspaper size={15} style={{ color: "var(--accent)" }} /> Editorial pulse</div>
        <Link href="/newsbites" className="v5-section-link">newsbites →</Link>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
        <span className="v5-stat-value gradient"><AnimatedNumber value={nb.publishedLast7d.reduce((a, b) => a + b, 0)} /></span>
        <span className="v5-stat-cap">articles in the last 7 days · site {nb.siteReachable ? "reachable" : "unreachable"}</span>
      </div>
      <div style={{ height: 120, margin: "0 -6px" }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chart} margin={{ top: 6, right: 8, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="ed7d" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="oklch(82% 0.14 200)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="oklch(70% 0.20 292)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis dataKey="i" hide />
            <Tooltip
              cursor={{ stroke: "var(--border-bright)" }}
              contentStyle={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12 }}
              labelStyle={{ display: "none" }}
              formatter={(v) => [`${v} articles`, ""]}
            />
            <Area type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={2} fill="url(#ed7d)" animationDuration={900} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {nb.topVerticals.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {nb.topVerticals.slice(0, 5).map((v) => (
            <span key={v.vertical} className="v5-pill">{v.vertical} · {v.count}</span>
          ))}
        </div>
      )}
      {nb.latestArticles.length > 0 && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          {nb.latestArticles.slice(0, 3).map((a) => (
            <div key={a.slug} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "5px 0", fontSize: 12.5 }}>
              <span style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 10.5, flex: "none" }}>{a.date}</span>
              <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── stack vitals ────────────────────────── */

function VitalBar({ label, pct, display }: { label: string; pct: number; display: string }) {
  const tone = pct >= 90 ? "var(--red)" : pct >= 70 ? "var(--amber-warn)" : "var(--green)";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
        <span style={{ color: "var(--text-dim)" }}>{label}</span>
        <span style={{ fontFamily: "var(--mono)", color: "var(--text-bright)" }}>{display}</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: "var(--bg-sub)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, borderRadius: 3, background: tone, transition: "width 0.9s var(--ease-out)" }} />
      </div>
    </div>
  );
}

function StackVitals({ d }: { d: HomeData }) {
  return (
    <div className="v5-card flat-hover">
      <div className="v5-section-head" style={{ marginBottom: 14 }}>
        <div className="v5-section-title"><GaugeCircle size={15} style={{ color: "var(--accent-2)" }} /> Stack vitals</div>
        <Link href="/infra" className="v5-section-link">infra →</Link>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <VitalBar label="memory" pct={d.hetzner.memUsedPct} display={`${Math.round(d.hetzner.memUsedPct)}%`} />
        <VitalBar label="disk" pct={d.hetzner.diskUsedPct} display={`${Math.round(d.hetzner.diskUsedPct)}%`} />
        <VitalBar label="load (1m)" pct={Math.min(100, d.hetzner.load1 * 25)} display={d.hetzner.load1.toFixed(2)} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 2 }}>
          <span className="v5-pill info">
            <Cpu size={11} />
            {d.vast.gpu ?? "gpu"}{d.vast.runwayHours !== null ? ` · ${Math.round(d.vast.runwayHours)}h runway` : ""}
          </span>
          {d.vast.hourlyRate !== null && <span className="v5-pill">${d.vast.hourlyRate.toFixed(3)}/h</span>}
          {d.gpu.loadedModels.slice(0, 2).map((m) => (
            <span key={m} className="v5-pill">{m}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── pipeline flow ───────────────────────── */

function PipelineFlow({ d }: { d: HomeData }) {
  const stages = Object.entries(d.autopipeline.stageBreakdown ?? {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...stages.map(([, v]) => v));
  return (
    <div className="v5-card flat-hover">
      <div className="v5-section-head" style={{ marginBottom: 14 }}>
        <div className="v5-section-title"><Workflow size={15} style={{ color: "var(--accent)" }} /> Pipeline stages</div>
        <Link href="/autopipeline" className="v5-section-link">pipeline →</Link>
      </div>
      {d.autopipeline.currentStory && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
          now: <span style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>{d.autopipeline.currentStory.stage}</span>
          {d.autopipeline.currentStory.slug ? ` · ${d.autopipeline.currentStory.slug}` : ""}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {stages.slice(0, 6).map(([stage, count]) => (
          <div key={stage} style={{ display: "grid", gridTemplateColumns: "110px 1fr 28px", alignItems: "center", gap: 10, fontSize: 12 }}>
            <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stage}</span>
            <div style={{ height: 6, borderRadius: 3, background: "var(--bg-sub)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(count / max) * 100}%`, background: "var(--grad-accent)", borderRadius: 3, transition: "width 0.9s var(--ease-out)" }} />
            </div>
            <span style={{ fontFamily: "var(--mono)", textAlign: "right", color: "var(--text-bright)" }}>{count}</span>
          </div>
        ))}
        {stages.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>queue is empty</div>}
      </div>
    </div>
  );
}

/* ─────────────────────────── governance ──────────────────────────── */

function Governance() {
  const { data: health } = useApi<AdminHealth>("/api/admin/health", 60_000);
  const { data: insightsData } = useApi<{ insights: FindingPreview[]; openCount: number }>("/api/insights?status=open", 30_000);
  const [briefing, setBriefing] = useState<string | null>(null);
  const fetched = useRef(false);

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    authFetch("/api/admin/briefing")
      .then((r) => r.json() as Promise<{ data?: { briefing?: { text: string } | null } }>)
      .then((d) => { if (d.data?.briefing?.text) setBriefing(d.data.briefing.text); })
      .catch(() => {});
  }, []);

  const score = health?.score ?? null;
  const crit = health?.openCritical ?? 0;
  const findings = (insightsData?.insights ?? []).slice(0, 3);

  return (
    <div className="v5-section">
      <Reveal>
        <div className="v5-section-head">
          <div className="v5-section-title"><Stethoscope size={15} style={{ color: "var(--accent-2)" }} /> Admin center</div>
          <Link href="/admin" className="v5-section-link">open →</Link>
        </div>
        <div className="v5-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <Link href="/admin" className="v5-card v5-stat" style={{ textDecoration: "none" }}>
            <div className="v5-card-label">health score</div>
            <div className="v5-stat-value" style={{ color: score === null ? "var(--text-muted)" : score >= 80 ? "var(--green)" : score >= 55 ? "var(--amber-warn)" : "var(--red)" }}>
              {score ?? "—"}<span style={{ fontSize: 15, color: "var(--text-muted)" }}>/100</span>
            </div>
            <div className="v5-stat-cap">{score === null ? "checking…" : score >= 80 ? "healthy" : score >= 55 ? "degraded" : "critical"}</div>
          </Link>
          <Link href="/insights?status=open&severity=critical" className="v5-card v5-stat" style={{ textDecoration: "none" }}>
            <div className="v5-card-label"><Dot tone={crit > 0 ? "err" : "ok"} /> open critical</div>
            <div className="v5-stat-value" style={{ color: crit > 0 ? "var(--red)" : "var(--green)" }}><AnimatedNumber value={crit} /></div>
            <div className="v5-stat-cap">{crit > 0 ? "needs attention" : "all clear"}</div>
          </Link>
          <Link href="/insights" className="v5-card v5-stat" style={{ textDecoration: "none" }}>
            <div className="v5-card-label">open detections</div>
            <div className="v5-stat-value"><AnimatedNumber value={insightsData?.openCount ?? 0} /></div>
            <div className="v5-stat-cap">across all severities</div>
          </Link>
        </div>

        {briefing && (
          <div className="v5-card glass flat-hover" style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "flex-start", borderColor: "var(--border-glow)" }}>
            <Sparkles size={15} style={{ color: "var(--accent)", flex: "none", marginTop: 2 }} />
            <span style={{ fontSize: 13, lineHeight: 1.6, flex: 1 }}>{briefing}</span>
            <Link href="/admin" className="v5-section-link" style={{ flex: "none" }}><ArrowUpRight size={13} /></Link>
          </div>
        )}

        {findings.length > 0 && (
          <div className="v5-card flat-hover" style={{ marginTop: 14, padding: 8 }}>
            {findings.map((f) => (
              <Link key={f.id} href={f.sourceKey ? `/insights?focus=${encodeURIComponent(f.sourceKey)}` : "/insights"}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", textDecoration: "none", color: "inherit", borderRadius: 10 }}>
                <span className={`v5-pill ${f.severity === "critical" || f.severity === "high" ? "err" : f.severity === "medium" ? "warn" : "info"}`}>{f.severity}</span>
                <span style={{ flex: 1, fontSize: 13 }}>{f.title}</span>
                <ArrowUpRight size={13} style={{ color: "var(--text-muted)" }} />
              </Link>
            ))}
          </div>
        )}
      </Reveal>
    </div>
  );
}

/* ─────────────────────────── loading ─────────────────────────────── */

function HomeLoading({ error }: { error?: string }) {
  return (
    <div>
      <div className="v5-skeleton" style={{ height: 240, borderRadius: 26 }} />
      <div className="v5-section v5-grid stats">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="v5-skeleton" style={{ height: 110 }} />)}
      </div>
      {error && <div style={{ marginTop: 16, fontSize: 12, color: "var(--text-muted)" }}>{error}</div>}
    </div>
  );
}

/* ─────────────────────────── page ────────────────────────────────── */

export function DashHome() {
  const { data: streamData } = useStream<HomeData>("/api/stream");
  const { data: pollData, loading, error } = useApi<HomeData>("/api/home", 60_000);
  const { data: mc } = useApi<MissionControlData>("/api/mission-control", 60_000);
  const data = streamData ?? pollData;

  if (loading && !data) return <HomeLoading />;
  if (error && !data) return <HomeLoading error={String(error)} />;
  if (!data) return <HomeLoading error="No home data is available yet." />;

  const d = data;

  return (
    <div>
      <Hero d={d} mc={mc ?? null} />
      {mc && <DecisionQueue mc={mc} />}
      <StatRow d={d} />
      <ServiceMesh d={d} />
      <div className="v5-section v5-grid split">
        <Reveal delay={0.04}><EditorialPulse d={d} /></Reveal>
        <Reveal delay={0.08}><StackVitals d={d} /></Reveal>
      </div>
      <div className="v5-section v5-grid split">
        <Reveal delay={0.04}><PipelineFlow d={d} /></Reveal>
        <Reveal delay={0.08}>
          <div className="v5-card flat-hover" style={{ height: "100%" }}>
            <div className="v5-section-head" style={{ marginBottom: 12 }}>
              <div className="v5-section-title"><Cpu size={15} style={{ color: "var(--accent)" }} /> Models</div>
              <Link href="/models" className="v5-section-link">models →</Link>
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <div>
                <div className="v5-stat-value" style={{ fontSize: 26 }}><AnimatedNumber value={d.models.availableByCapability.heavy + d.models.availableByCapability.medium + d.models.availableByCapability.light} /></div>
                <div className="v5-stat-cap">available</div>
              </div>
              <div>
                <div className="v5-stat-value" style={{ fontSize: 26, color: d.models.qualitySummary.blocked > 0 ? "var(--red)" : undefined }}><AnimatedNumber value={d.models.qualitySummary.blocked} /></div>
                <div className="v5-stat-cap">blocked</div>
              </div>
              <div>
                <div className="v5-stat-value" style={{ fontSize: 26 }}><AnimatedNumber value={d.models.newModelsAdded.length} /></div>
                <div className="v5-stat-cap">new this check</div>
              </div>
            </div>
            {d.models.bestLocal && (
              <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-dim)" }}>
                best local: <span style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>{d.models.bestLocal}</span>
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <Sparkline points={d.newsbites.publishedLast7d} width={220} height={36} stroke="var(--accent-2)" />
            </div>
          </div>
        </Reveal>
      </div>
      <Governance />
    </div>
  );
}
