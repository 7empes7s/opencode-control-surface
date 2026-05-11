import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import {
  LayoutGrid,
  Workflow,
  Stethoscope,
  Cpu,
  Newspaper,
  Server,
  AlertTriangle,
  ClipboardList,
  History,
  Terminal,
  Sparkles,
  Code2,
  X,
  Menu,
  CalendarDays,
  Settings2,
} from "lucide-react";
import { useStream } from "../hooks/useStream";
import type { HomeData } from "../../server/api/types";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  match?: (loc: string) => boolean;
};

const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: LayoutGrid, match: (l) => l === "/" },
  { href: "/today", label: "Today", icon: CalendarDays },
  { href: "/autopipeline", label: "Pipeline", icon: Workflow },
  { href: "/doctor", label: "Doctor", icon: Stethoscope },
  { href: "/models", label: "Models", icon: Cpu },
  { href: "/newsbites", label: "NewsBites", icon: Newspaper },
  { href: "/infra", label: "Infra", icon: Server },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/jobs", label: "Jobs", icon: ClipboardList },
  { href: "/audit", label: "Audit", icon: History },
  { href: "/settings", label: "Settings", icon: Settings2 },
  { href: "/opencode", label: "OpenCode", icon: Terminal },
  { href: "/codex", label: "Codex", icon: Code2 },
  { href: "/claude", label: "Claude Code", icon: Sparkles },
];

function ServicePulse() {
  const { data, connected } = useStream<HomeData>("/api/stream");
  if (!data) {
    return (
      <div className="rail-stack">
        <div className="rail-stack-title">stack</div>
        <div className="rail-stack-empty">…</div>
      </div>
    );
  }

  const services = data.services ?? [];
  const failed = services.filter((s) => s.status === "failed").length;
  const inactive = services.filter((s) => s.status === "inactive").length;
  const total = services.length;
  const healthy = total - failed - inactive;

  let band: "ok" | "warn" | "err" = "ok";
  if (failed > 0) band = "err";
  else if (inactive > 0) band = "warn";

  const gpuStatus = data.gpu?.status ?? "unknown";
  const queue = data.autopipeline?.queueDepth ?? 0;
  const paused = data.autopipeline?.paused ?? false;

  return (
    <div className="rail-stack">
      <div className="rail-stack-title">
        <span>stack</span>
        <span className={`live-dot ${connected ? "" : "off"}`} title={connected ? "live" : "polling"} />
      </div>

      <div className={`rail-band ${band}`}>
        <div className="rail-band-bar">
          {services.map((s) => (
            <span key={s.name} className={`rail-band-tick ${s.status}`} title={`${s.name}: ${s.status}`} />
          ))}
        </div>
        <div className="rail-band-meta">
          {healthy}/{total} services
        </div>
      </div>

      <div className="rail-kv">
        <span className="rail-kv-key">GPU</span>
        <span className={`rail-kv-val ${gpuStatus === "up" ? "ok" : gpuStatus === "down" ? "err" : "warn"}`}>
          {gpuStatus}
        </span>
      </div>
      <div className="rail-kv">
        <span className="rail-kv-key">Pipeline</span>
        <span className={`rail-kv-val ${paused ? "warn" : "ok"}`}>
          {paused ? "paused" : "running"}
        </span>
      </div>
      <div className="rail-kv">
        <span className="rail-kv-key">Queue</span>
        <span className="rail-kv-val">{queue}</span>
      </div>
      {data.vast?.balance !== null && data.vast?.balance !== undefined && (
        <div className="rail-kv">
          <span className="rail-kv-key">Vast</span>
          <span className="rail-kv-val">
            ${((data.vast.balance ?? 0) + (data.vast.credit ?? 0)).toFixed(0)}
          </span>
        </div>
      )}
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  return (
    <ul className="rail-nav">
      {NAV.map(({ href, label, icon: Icon, match }) => {
        const active = match ? match(location) : location.startsWith(href);
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              className={`rail-nav-link${active ? " active" : ""}`}
            >
              <Icon size={16} strokeWidth={1.75} />
              <span>{label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function DashSidebar() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [location] = useLocation();

  useEffect(() => {
    setDrawerOpen(false);
  }, [location]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

  const currentLabel =
    NAV.find((n) => (n.match ? n.match(location) : location.startsWith(n.href)))?.label ??
    "Home";

  return (
    <>
      {/* ── Desktop / tablet rail ──────────────────────────── */}
      <aside className="rail">
        <div className="rail-brand">
          <span className="rail-brand-mark" />
          <span className="rail-brand-name">TIB</span>
          <span className="rail-brand-sub">Control</span>
        </div>
        <NavList />
        <div className="rail-spacer" />
        <ServicePulse />
      </aside>

      {/* ── Mobile top bar ─────────────────────────────────── */}
      <header className="topbar-mobile">
        <button
          type="button"
          className="topbar-mobile-btn"
          aria-label="Open navigation"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={18} strokeWidth={1.75} />
        </button>
        <div className="topbar-mobile-title">
          <span className="rail-brand-mark" />
          <span>{currentLabel}</span>
        </div>
        <span className="topbar-mobile-spacer" />
      </header>

      {/* ── Mobile drawer ──────────────────────────────────── */}
      {drawerOpen && (
        <div className="drawer-overlay" onClick={() => setDrawerOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div className="rail-brand">
                <span className="rail-brand-mark" />
                <span className="rail-brand-name">TIB</span>
                <span className="rail-brand-sub">Control</span>
              </div>
              <button
                type="button"
                className="drawer-close"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={18} strokeWidth={1.75} />
              </button>
            </div>
            <NavList onNavigate={() => setDrawerOpen(false)} />
            <div className="drawer-foot">
              <ServicePulse />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
