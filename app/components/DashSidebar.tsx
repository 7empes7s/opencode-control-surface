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
  CalendarDays,
  Settings2,
  MoreHorizontal,
  Moon,
  Sun,
  Monitor,
  LayoutDashboard,
  Hammer,
  Menu,
} from "lucide-react";
import { useStream } from "../hooks/useStream";
import type { HomeData } from "../../server/api/types";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  match?: (loc: string) => boolean;
};
type Theme = "dark" | "light";
type Variant = "terminal" | "compact";

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
  { href: "/builder", label: "Builder", icon: Hammer },
  { href: "/settings", label: "Settings", icon: Settings2 },
  { href: "/opencode", label: "OpenCode", icon: Terminal },
  { href: "/codex", label: "Codex", icon: Code2 },
  { href: "/claude", label: "Claude Code", icon: Sparkles },
  { href: "/gemini", label: "Gemini", icon: Sparkles },
];

const PRIMARY_NAV: NavItem[] = [
  NAV[0],  // Home
  NAV[2],  // Pipeline
  NAV[3],  // Doctor
  NAV[5],  // NewsBites
  NAV[12], // OpenCode
];

function isActive(item: NavItem, location: string): boolean {
  return item.match ? item.match(location) : location.startsWith(item.href);
}

function usePreferences() {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem("tib-theme") as Theme) || "dark"
  );
  const [variant, setVariantState] = useState<Variant>(
    () => (localStorage.getItem("tib-variant") as Variant) || "terminal"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-variant", variant);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("tib-theme", t);
  };
  const setVariant = (v: Variant) => {
    setVariantState(v);
    document.documentElement.setAttribute("data-variant", v);
    localStorage.setItem("tib-variant", v);
  };

  return { theme, setTheme, variant, setVariant };
}

/* ── Compact stack status for top nav ─────────────────────────────────── */
function StackPill() {
  const { data, connected } = useStream<HomeData>("/api/stream");
  if (!data) return <span className="topnav-stack-pill checking">…</span>;

  const services = data.services ?? [];
  const failed = services.filter((s) => s.status === "failed").length;
  const inactive = services.filter((s) => s.status === "inactive").length;
  const healthy = services.length - failed - inactive;
  const band = failed > 0 ? "err" : inactive > 0 ? "warn" : "ok";

  return (
    <span
      className={`topnav-stack-pill ${band}`}
      title={`${healthy}/${services.length} services · GPU ${data.gpu?.status ?? "?"} · Q${data.autopipeline?.queueDepth ?? 0}`}
    >
      <span className={`live-dot ${connected ? "" : "off"}`} />
      <span className="topnav-stack-label">
        {failed > 0 ? `${failed} failed` : inactive > 0 ? `${inactive} inactive` : "ok"}
      </span>
    </span>
  );
}

export function DashSidebar() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [topnavExpanded, setTopnavExpanded] = useState(false);
  const [location] = useLocation();
  const { theme, setTheme, variant, setVariant } = usePreferences();

  useEffect(() => { setDrawerOpen(false); setTopnavExpanded(false); }, [location]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

  const moreActive = !PRIMARY_NAV.some((n) => isActive(n, location));

  return (
    <>
      {/* ── Top nav (all screen sizes) ───────────────────── */}
      <header className="dash-topnav">
        <div className="topnav-brand">
          <span className="rail-brand-mark" />
          <span className="rail-brand-name">TIB</span>
          <span className="rail-brand-sub">Control</span>
        </div>

<nav className="topnav-links" aria-label="Main navigation">
          {NAV.map(({ href, label, icon: Icon, match }) => {
            const active = match ? match(location) : location.startsWith(href);
            return (
              <Link key={href} href={href} className={`topnav-link${active ? " active" : ""}`}>
                <Icon size={13} strokeWidth={1.75} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        {topnavExpanded && (
          <div className="topnav-links-expanded open" role="navigation" aria-label="All pages">
            {NAV.map(({ href, label, icon: Icon, match }) => {
              const active = match ? match(location) : location.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`topnav-link${active ? " active" : ""}`}
                  onClick={() => setTopnavExpanded(false)}
                >
                  <Icon size={15} strokeWidth={1.75} />
                  <span>{label}</span>
                </Link>
              );
            })}
          </div>
        )}

        <div className="topnav-right">
          <StackPill />
          <button
            type="button"
            className="topnav-hamburger"
            aria-label="Open navigation menu"
            aria-expanded={topnavExpanded}
            onClick={() => setTopnavExpanded((v) => !v)}
          >
            <Menu size={15} strokeWidth={1.75} />
          </button>
          <div className="topnav-toggle-group" title="Theme">
            <button
              className={`topnav-mode-btn${theme === "dark" ? " active" : ""}`}
              onClick={() => setTheme("dark")}
              title="Dark mode"
            >
              <Moon size={11} strokeWidth={1.75} />
            </button>
            <button
              className={`topnav-mode-btn${theme === "light" ? " active" : ""}`}
              onClick={() => setTheme("light")}
              title="Light mode"
            >
              <Sun size={11} strokeWidth={1.75} />
            </button>
          </div>
          <div className="topnav-toggle-group" title="Variant">
            <button
              className={`topnav-mode-btn${variant === "terminal" ? " active" : ""}`}
              onClick={() => setVariant("terminal")}
              title="Terminal variant"
            >
              <Monitor size={11} strokeWidth={1.75} />
            </button>
            <button
              className={`topnav-mode-btn${variant === "compact" ? " active" : ""}`}
              onClick={() => setVariant("compact")}
              title="Compact variant"
            >
              <LayoutDashboard size={11} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </header>

      {/* ── Mobile bottom tab bar ─────────────────────────── */}
      <nav className="dash-bottomnav" aria-label="Mobile navigation">
        {PRIMARY_NAV.map((item) => {
          const active = isActive(item, location);
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className={`bn-tab${active ? " active" : ""}`}>
              <Icon size={20} strokeWidth={1.6} />
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={`bn-tab${moreActive ? " active" : ""}`}
          onClick={() => setDrawerOpen(true)}
          aria-label="More pages"
        >
          <MoreHorizontal size={20} strokeWidth={1.6} />
          <span>More</span>
        </button>
      </nav>

      {/* ── Drawer (all pages grid) ───────────────────────── */}
      {drawerOpen && (
        <div className="drawer-overlay" onClick={() => setDrawerOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <span className="drawer-head-title">All pages</span>
              <button
                type="button"
                className="drawer-close"
                aria-label="Close"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
            <div className="drawer-nav-grid">
              {NAV.map(({ href, label, icon: Icon, match }) => {
                const active = match ? match(location) : location.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`drawer-nav-item${active ? " active" : ""}`}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <Icon size={22} strokeWidth={1.5} />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
