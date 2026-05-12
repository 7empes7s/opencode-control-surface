import { useEffect, useRef, useState } from "react";

/* ── AnimatedNumber ─────────────────────────────────────────────────────── */

export function AnimatedNumber({
  value,
  duration = 700,
  format = (n: number) => String(n),
  className = "",
}: {
  value: number;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    let raf: number;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const ease = 1 - Math.pow(1 - k, 3);
      setDisplay(Math.round(from + (to - from) * ease));
      if (k < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <span className={`anim-number ${className}`}>{format(display)}</span>;
}

/* ── Gauge ──────────────────────────────────────────────────────────────── */

export function Gauge({
  pct,
  label,
  unit = "%",
  thresholds = { warn: 80, crit: 95 },
}: {
  pct: number;
  label: string;
  unit?: string;
  thresholds?: { warn: number; crit: number };
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 60;
  const C = Math.PI * r;
  const offset = C - (clamped / 100) * C;
  const color =
    clamped >= thresholds.crit ? "var(--red)" :
    clamped >= thresholds.warn ? "var(--amber-warn)" :
    "var(--green)";

  return (
    <div className="anim-gauge">
      <svg viewBox="0 0 160 90" className="anim-gauge-svg">
        <path
          className="anim-gauge-track"
          d="M20 80 A60 60 0 0 1 140 80"
        />
        <path
          className="anim-gauge-fill"
          d="M20 80 A60 60 0 0 1 140 80"
          stroke={color}
          strokeDasharray={C}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.25,1,0.5,1), stroke 0.4s" }}
        />
      </svg>
      <div className="anim-gauge-label">{label}</div>
      <div className="anim-gauge-val" style={{ color }}>
        <AnimatedNumber value={Math.round(clamped)} />
        <span className="anim-gauge-unit">{unit}</span>
      </div>
    </div>
  );
}

/* ── PipelineFlowBar ────────────────────────────────────────────────────── */

export function PipelineFlowBar({
  stages,
}: {
  stages: Array<{ name: string; count: number; hot?: boolean; warn?: boolean }>;
}) {
  return (
    <div className="anim-flow">
      {stages.map((s, i) => (
        <div key={s.name} className="anim-flow-item">
          <div
            className={`anim-flow-bubble${s.hot ? " hot" : s.warn ? " warn" : s.count > 0 ? " active" : ""}`}
          >
            <AnimatedNumber value={s.count} />
          </div>
          <div className="anim-flow-label">{s.name}</div>
          {i < stages.length - 1 && (
            <div className={`anim-flow-arrow${s.count > 0 || s.hot ? " active" : ""}`}>
              {(s.hot || s.count > 0) && <span className="anim-flow-dot" style={{ animationDelay: `${i * 0.5}s` }} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── AreaSparkline ──────────────────────────────────────────────────────── */

export function AreaSparkline({
  values,
  height = 52,
  color = "var(--accent)",
  gradientId,
}: {
  values: number[];
  height?: number;
  color?: string;
  gradientId?: string;
}) {
  const id = gradientId ?? `area-grad-${Math.random().toString(36).slice(2)}`;
  if (values.length < 2) return null;

  const W = 600;
  const H = height;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const dx = W / (values.length - 1);
  const pad = 4;

  const pts = values.map((v, i) => [
    i * dx,
    H - pad - ((v - min) / span) * (H - pad * 2),
  ] as [number, number]);

  // Smooth bezier path
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C ${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  const area = `${d} L ${pts[pts.length - 1][0]},${H} L ${pts[0][0]},${H} Z`;

  const last = pts[pts.length - 1];

  return (
    <svg
      className="anim-area"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height }}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="100%" stopColor={color} stopOpacity="0.04" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="4" fill={color} />
    </svg>
  );
}

/* ── LiveTick ───────────────────────────────────────────────────────────── */

export function LiveTick({ live }: { live: boolean }) {
  return (
    <span
      className="live-tick"
      style={{ background: live ? "var(--green)" : "var(--text-dim)" }}
      title={live ? "live" : "offline"}
    />
  );
}

/* ── IncidentHeatmap (7-day hourly buckets) ─────────────────────────────── */

export function IncidentHeatmap({
  buckets,
}: {
  buckets: Array<{ day: string; hour: number; count: number }>;
}) {
  if (buckets.length === 0) return <div className="loading-dim">no data</div>;

  const days = Array.from(new Set(buckets.map((b) => b.day))).sort().slice(-7);
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const hours = Array.from({ length: 24 }, (_, i) => i);

  const cell = (day: string, hour: number) => {
    const b = buckets.find((x) => x.day === day && x.hour === hour);
    const v = b?.count ?? 0;
    const intensity = v / maxCount;
    return (
      <div
        key={`${day}-${hour}`}
        className="heatmap-cell"
        style={{ opacity: v > 0 ? 0.2 + intensity * 0.8 : 0.06 }}
        title={`${day} ${String(hour).padStart(2, "0")}:00 — ${v} events`}
      />
    );
  };

  return (
    <div className="heatmap">
      <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
        {days.flatMap((day) => hours.map((h) => cell(day, h)))}
      </div>
      <div className="heatmap-labels">
        {days.map((day) => (
          <span key={day} className="heatmap-day">{day.slice(5)}</span>
        ))}
      </div>
    </div>
  );
}
