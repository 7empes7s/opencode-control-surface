import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { AnimatePresence, motion } from "framer-motion";
import {
  LayoutGrid, Workflow, Stethoscope, Cpu, Newspaper, Server, AlertTriangle,
  ClipboardList, History, Terminal, Sparkles, Code2, X, CalendarDays,
  Settings2, MoreHorizontal, Moon, Sun, Hammer, Menu, GitBranch, Route,
  Shield, FolderOpen, Info, Wrench, Package, TrendingUp, Radar, Bell,
  Lightbulb, Bot, Inbox, FileCheck2, FileText, ShieldAlert, Database,
} from "lucide-react";
import { useStream } from "../hooks/useStream";
import type { HomeData } from "../../server/api/types";
import { NAV_ITEMS, isExperimental } from "../lib/navRegistry";

type Theme = "dark" | "light";

const NAV_ICONS: Record<string, typeof LayoutGrid> = {
  "/admin": ShieldAlert, "/": LayoutGrid, "/insights": Inbox, "/security": Shield,
  "/agents": Bot, "/today": CalendarDays, "/autopipeline": Workflow,
  "/doctor": Stethoscope, "/models": Cpu, "/cost": TrendingUp,
  "/newsbites": Newspaper, "/know": Sparkles, "/infra": Server,
  "/incidents": AlertTriangle, "/jobs": ClipboardList, "/agent-team": Bot,
  "/audit": History, "/builder": Hammer, "/brainstorm": Lightbulb,
  "/workflows": GitBranch, "/marketplace": Package, "/traces": GitBranch,
  "/gateway": Route, "/governance": Shield, "/compliance": Shield,
  "/projects": FolderOpen, "/settings": Settings2, "/about": Info,
  "/install": Wrench, "/litellm": Route, "/opencode": Terminal,
  "/codex": Code2, "/claude": Sparkles, "/gemini": Sparkles,
  "/terminal": Terminal, "/finance-intel": TrendingUp, "/scout": Radar,
  "/channels": Bell, "/content-health": FileCheck2, "/reports": FileText,
  "/data-explorer": Database, "/feature-flags": Settings2,
};

/* Ordered rail groups — every registry href appears exactly once. */
const RAIL_GROUPS: Array<{ label: string; items: string[] }> = [
  { label: "Command", items: ["/", "/today", "/insights", "/incidents", "/security"] },
  { label: "Content", items: ["/autopipeline", "/newsbites", "/know", "/brainstorm", "/scout", "/content-health", "/finance-intel"] },
  { label: "Agents", items: ["/agents", "/agent-team", "/opencode", "/codex", "/claude", "/gemini", "/terminal", "/builder", "/hyperagent"] },
  { label: "Stack", items: ["/models", "/cost", "/infra", "/jobs", "/gateway", "/litellm", "/audit", "/reports", "/data-explorer"] },
  { label: "System", items: ["/workflows", "/runbooks", "/governance", "/compliance", "/feature-flags", "/projects", "/marketplace", "/settings", "/admin", "/about", "/install"] },
];

const MOBILE_TABS = ["/", "/today", "/autopipeline", "/agents"];

const LABELS = new Map(NAV_ITEMS.map((i) => [i.href, i.label]));

function useTheme() {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem("tib-theme") as Theme) || "dark"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem("tib-theme", t);
  };
  return { theme, setTheme };
}

function StackPill() {
  const { data, connected } = useStream<HomeData>("/api/stream");
  if (!data) return <span className="v5-pill">…</span>;
  const services = data.services ?? [];
  const failed = services.filter((s) => s.status === "failed").length;
  const inactive = services.filter((s) => s.status === "inactive").length;
  const tone = failed > 0 ? "err" : inactive > 0 ? "warn" : "ok";
  const label = failed > 0 ? `${failed} failed` : inactive > 0 ? `${inactive} down` : `${services.length} up`;
  return (
    <span className={`v5-pill ${tone}`} title={`GPU ${data.gpu?.status ?? "?"} · queue ${data.autopipeline?.queueDepth ?? 0} · stream ${connected ? "live" : "polling"}`}>
      <span className={`v5-dot ${tone}`} />
      {label}
    </span>
  );
}

function railActive(href: string, location: string): boolean {
  return href === "/" ? location === "/" : location.startsWith(href);
}

/* ── Desktop rail ─────────────────────────────────────────────────────────── */
function Rail({ location, theme, onToggleTheme }: { location: string; theme: Theme; onToggleTheme: () => void }) {
  return (
    <aside className="v5-rail" aria-label="Main navigation">
      <div className="v5-rail-brand">
        <span className="v5-rail-mark" />
        <span>
          <div className="v5-rail-name">TIB Control</div>
          <div className="v5-rail-sub">Observatory</div>
        </span>
      </div>

      <div className="v5-rail-scroll">
        {RAIL_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="v5-rail-group-label">{group.label}</div>
            {group.items.map((href) => {
              const Icon = NAV_ICONS[href] ?? LayoutGrid;
              const active = railActive(href, location);
              return (
                <Link key={href} href={href} className={`v5-rail-item${active ? " active" : ""}`}>
                  <Icon size={16} strokeWidth={1.8} />
                  <span style={{ flex: 1 }}>{LABELS.get(href) ?? href}</span>
                  {isExperimental(href) && (
                    <span style={{ fontSize: 9, opacity: 0.6, letterSpacing: "0.06em" }}>LAB</span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="v5-rail-foot">
        <StackPill />
        <button
          type="button"
          className="v5-icon-btn"
          onClick={onToggleTheme}
          title={`Theme: ${theme} — click to switch`}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Moon size={15} strokeWidth={1.8} /> : <Sun size={15} strokeWidth={1.8} />}
        </button>
      </div>
    </aside>
  );
}

/* ── Mobile chrome ────────────────────────────────────────────────────────── */
function MobileChrome({ location, menuOpen, setMenuOpen, theme, onToggleTheme }: {
  location: string; menuOpen: boolean; setMenuOpen: (v: boolean) => void;
  theme: Theme; onToggleTheme: () => void;
}) {
  const title = (() => {
    if (location === "/") return "TIB Control";
    const match = NAV_ITEMS.filter((i) => i.href !== "/" && location.startsWith(i.href)).sort((a, b) => b.href.length - a.href.length)[0];
    return match?.label ?? "TIB Control";
  })();

  return (
    <>
      <header className="v5-topbar">
        <button type="button" className="v5-icon-btn" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
          <Menu size={18} strokeWidth={1.8} />
        </button>
        <div className="v5-topbar-title">{title}</div>
        <StackPill />
      </header>

      <nav className="v5-tabbar" aria-label="Primary">
        {MOBILE_TABS.map((href) => {
          const Icon = NAV_ICONS[href] ?? LayoutGrid;
          const active = railActive(href, location);
          return (
            <Link key={href} href={href} className={`v5-tab${active ? " active" : ""}`}>
              <Icon size={21} strokeWidth={1.7} />
              <span>{LABELS.get(href) ?? href}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={`v5-tab${!MOBILE_TABS.some((h) => railActive(h, location)) ? " active" : ""}`}
          onClick={() => setMenuOpen(true)}
          aria-label="All pages"
        >
          <MoreHorizontal size={21} strokeWidth={1.7} />
          <span>More</span>
        </button>
      </nav>

      <AnimatePresence>
        {menuOpen && (
          <motion.div
            className="v5-menu-overlay"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="v5-menu-head">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="v5-rail-mark" />
                <span className="v5-rail-name">TIB Control</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="v5-icon-btn" onClick={onToggleTheme} aria-label="Toggle theme">
                  {theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}
                </button>
                <button type="button" className="v5-icon-btn" onClick={() => setMenuOpen(false)} aria-label="Close menu">
                  <X size={17} />
                </button>
              </div>
            </div>
            {RAIL_GROUPS.map((group, gi) => (
              <div key={group.label} style={{ marginBottom: 20 }}>
                <div className="v5-rail-group-label" style={{ padding: "0 2px 8px" }}>{group.label}</div>
                <div className="v5-menu-grid">
                  {group.items.map((href, i) => {
                    const Icon = NAV_ICONS[href] ?? LayoutGrid;
                    const active = railActive(href, location);
                    return (
                      <motion.div
                        key={href}
                        initial={{ opacity: 0, y: 14 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.03 * (gi * 8 + i), duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <Link href={href} className={`v5-menu-item${active ? " active" : ""}`} onClick={() => setMenuOpen(false)}>
                          <Icon size={22} strokeWidth={1.6} />
                          <span>{LABELS.get(href) ?? href}</span>
                        </Link>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export function DashSidebar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [location] = useLocation();
  const { theme, setTheme } = useTheme();

  useEffect(() => { setMenuOpen(false); }, [location]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  return (
    <>
      <Rail location={location} theme={theme} onToggleTheme={toggleTheme} />
      <MobileChrome location={location} menuOpen={menuOpen} setMenuOpen={setMenuOpen} theme={theme} onToggleTheme={toggleTheme} />
    </>
  );
}
