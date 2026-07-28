import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useInView, useMotionValue, useSpring } from "framer-motion";

/* ── Animated number (spring) ─────────────────────────────────────────────── */
export function AnimatedNumber({ value, decimals = 0, suffix = "", prefix = "" }: {
  value: number; decimals?: number; suffix?: string; prefix?: string;
}) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 90, damping: 22 });
  const [display, setDisplay] = useState("0");
  useEffect(() => { mv.set(value); }, [value, mv]);
  useEffect(() => {
    const unsub = spring.on("change", (v) => {
      setDisplay(v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
    });
    return unsub;
  }, [spring, decimals]);
  return <span>{prefix}{display}{suffix}</span>;
}

/* ── Fade-up entrance wrapper (stagger via delay) ─────────────────────────── */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/* ── Count-up when scrolled into view ─────────────────────────────────────── */
export function RevealOnView({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 18 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/* ── Status dot ───────────────────────────────────────────────────────────── */
export function Dot({ tone }: { tone: "ok" | "warn" | "err" | "idle" }) {
  return <span className={`v5-dot ${tone}`} />;
}

/* ── Stat tile ────────────────────────────────────────────────────────────── */
export function Stat({ label, value, caption, gradient, tone }: {
  label: string; value: ReactNode; caption?: string; gradient?: boolean;
  tone?: "ok" | "warn" | "err" | "idle";
}) {
  return (
    <div className="v5-card flat-hover v5-stat">
      <div className="v5-card-label">
        {tone && <Dot tone={tone} />}
        {label}
      </div>
      <div className={`v5-stat-value${gradient ? " gradient" : ""}`}>{value}</div>
      {caption && <div className="v5-stat-cap">{caption}</div>}
    </div>
  );
}

/* ── SVG sparkline (dependency-free) ──────────────────────────────────────── */
export function Sparkline({ points, width = 120, height = 32, stroke = "var(--accent)", fill = true }: {
  points: number[]; width?: number; height?: number; stroke?: string; fill?: boolean;
}) {
  if (points.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => [i * stepX, height - 3 - ((p - min) / span) * (height - 6)] as const);
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const id = useRef(`sg${Math.random().toString(36).slice(2, 8)}`);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", overflow: "visible" }}>
      {fill && (
        <>
          <defs>
            <linearGradient id={id.current} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.30" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id.current})`} stroke="none" />
        </>
      )}
      <motion.path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.1, ease: "easeOut" }}
      />
      <circle cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]} r="2.6" fill={stroke} />
    </svg>
  );
}

/* ── Posture ring (radial gauge) ──────────────────────────────────────────── */
export function PostureRing({ pct, tone, label, sub }: {
  pct: number; tone: "ok" | "warn" | "err"; label: string; sub?: string;
}) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const color = tone === "ok" ? "var(--green)" : tone === "warn" ? "var(--amber-warn)" : "var(--red)";
  return (
    <div className="v5-ring-wrap">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={R} fill="none" stroke="var(--border)" strokeWidth="7" />
        <motion.circle
          cx="60" cy="60" r={R} fill="none"
          stroke={color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={C}
          initial={{ strokeDashoffset: C }}
          animate={{ strokeDashoffset: C * (1 - Math.min(100, Math.max(0, pct)) / 100) }}
          transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
          style={{ filter: `drop-shadow(0 0 10px ${color})` }}
        />
      </svg>
      <div className="v5-ring-center">
        <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 22, color: "var(--text-bright)" }}>{label}</span>
        {sub && <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{sub}</span>}
      </div>
    </div>
  );
}

/* ── Section header ───────────────────────────────────────────────────────── */
export function SectionHead({ title, icon, link, linkLabel }: {
  title: string; icon?: ReactNode; link?: string; linkLabel?: string;
}) {
  return (
    <div className="v5-section-head">
      <div className="v5-section-title">{icon}{title}</div>
      {link && <a href={link} className="v5-section-link">{linkLabel ?? "see all"} →</a>}
    </div>
  );
}
