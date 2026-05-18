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
  GitBranch,
  Route,
  Shield,
  FolderOpen,
  Info,
  Wrench,
  Package,
  TrendingUp,
  Radar,
  Paperclip,
  Bell,
} from "lucide-react";
import { useStream } from "../hooks/useStream";
import type { HomeData } from "../../server/api/types";
import { getRouteStatus, isExperimental, type RouteStatus } from "../lib/navRegistry";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  match?: (loc: string) => boolean;
  condition?: () => boolean;
  status?: RouteStatus;
};
type Theme = "dark" | "light";
type Variant = "terminal" | "compact";

const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: LayoutGrid, match: (l) => l === "/" },
  { href: "/today", label: "Today", icon: CalendarDays },
  { href: "/autopipeline", label: "Pipeline", icon: Workflow },
  { href: "/doctor", label: "Doctor", icon: Stethoscope },
  { href: "/models", label: "Models", icon: Cpu },
  { href: "/cost", label: "Cost", icon: TrendingUp },
  { href: "/newsbites", label: "NewsBites", icon: Newspaper },
  { href: "/infra", label: "Infra", icon: Server },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/jobs", label: "Jobs", icon: ClipboardList },
  { href: "/audit", label: "Audit", icon: History },
  { href: "/builder", label: "Builder", icon: Hammer },
  { href: "/workflows", label: "Workflows", icon: GitBranch },
  { href: "/marketplace", label: "Marketplace", icon: Package },
  { href: "/traces", label: "Traces", icon: GitBranch },
  { href: "/gateway", label: "Gateway", icon: Route },
  { href: "/governance", label: "Governance", icon: Shield },
  { href: "/compliance", label: "Compliance", icon: Shield },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/settings", label: "Settings", icon: Settings2 },
  { href: "/about", label: "About", icon: Info },
  { href: "/install", label: "Setup", icon: Wrench, condition: () => localStorage.getItem("tib-install-wizard-done") !== "true" },
  { href: "/litellm", label: "LiteLLM", icon: Route },
  { href: "/paperclip", label: "Paperclip", icon: Paperclip },
  { href: "/opencode", label: "OpenCode", icon: Terminal },
  { href: "/codex", label: "Codex", icon: Code2 },
  { href: "/claude", label: "Claude Code", icon: Sparkles },
  { href: "/gemini", label: "Gemini", icon: Sparkles },
  { href: "/finance-intel", label: "Finance Intel", icon: TrendingUp },
  { href: "/scout", label: "Scout", icon: Radar },
  { href: "/channels", label: "Channels", icon: Bell },
];

const CORE_NAV: NavItem[] = NAV.filter((item) => getRouteStatus(item.href) === "core");
const ADVANCED_NAV: NavItem[] = NAV.filter((item) => getRouteStatus(item.href) === "advanced");

const PRIMARY_NAV: NavItem[] = ["/", "/today", "/autopipeline", "/models", "/opencode"]
  .map((href) => CORE_NAV.find((item) => item.href === href))
  .filter((item): item is NavItem => Boolean(item));

function isActive(item: NavItem, location: string): boolean {
  return item.match ? item.match(location) : location.startsWith(item.href);
}

function ExperimentalBadge() {
  return <span className="pill amber" style={{ fontSize: 9, padding: "1px 5px", marginLeft: 6, lineHeight: 1 }}>Labs</span>;
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

  const moreActive = !CORE_NAV.some((n) => isActive(n, location));

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
          {CORE_NAV.concat(ADVANCED_NAV).filter(item => !item.condition || item.condition()).map(({ href, label, icon: Icon, match }) => {
            const active = match ? match(location) : location.startsWith(href);
            const exp = isExperimental(href);
            return (
              <Link key={href} href={href} className={`topnav-link${active ? " active" : ""}`}>
                <Icon size={13} strokeWidth={1.75} />
                <span>{label}</span>
                {exp && <ExperimentalBadge />}
              </Link>
            );
          })}
        </nav>

        {topnavExpanded && (
          <div className="topnav-links-expanded open" role="navigation" aria-label="All pages">
            {CORE_NAV.concat(ADVANCED_NAV).filter(item => !item.condition || item.condition()).map(({ href, label, icon: Icon, match }) => {
              const active = match ? match(location) : location.startsWith(href);
              const exp = isExperimental(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`topnav-link${active ? " active" : ""}`}
                  onClick={() => setTopnavExpanded(false)}
                >
                  <Icon size={15} strokeWidth={1.75} />
                  <span>{label}</span>
                  {exp && <ExperimentalBadge />}
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
              {NAV.filter(item => (!item.condition || item.condition()) && getRouteStatus(item.href) !== "hidden").map(({ href, label, icon: Icon, match }) => {
                const active = match ? match(location) : location.startsWith(href);
                const exp = isExperimental(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`drawer-nav-item${active ? " active" : ""}${exp ? " experimental" : ""}`}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <Icon size={22} strokeWidth={1.5} />
                    <span>{label}</span>
                    {exp && <ExperimentalBadge />}
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
