import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Search, ArrowRight, Loader2, LayoutGrid, ShieldAlert, Inbox,
  Shield, Lock, ClipboardList, History, FileCheck2, Server,
  Stethoscope, Cpu, Workflow, AlertTriangle, Settings2,
  TrendingUp, Route, Newspaper, Hammer, Terminal, Code2, Sparkles,
  Play, CheckCircle2,
} from "lucide-react";
import { authFetch } from "../lib/authFetch";

// ── Route catalog ────────────────────────────────────────────────────────────

type RouteItem = { href: string; label: string; description: string; icon: typeof LayoutGrid; group: string };

const ROUTES: RouteItem[] = [
  { href: "/admin", label: "Admin Center", description: "Health score, detections, governance overview", icon: ShieldAlert, group: "Admin" },
  { href: "/insights", label: "Detections & Auto-fix", description: "AI-reasoned findings and remediations", icon: Inbox, group: "Admin" },
  { href: "/security", label: "Security", description: "Trust score, posture, vulnerabilities", icon: Shield, group: "Admin" },
  { href: "/governance", label: "Access & Policy", description: "RBAC, budgets, approvals", icon: Lock, group: "Admin" },
  { href: "/compliance", label: "Compliance", description: "Control mapping and evidence", icon: ClipboardList, group: "Admin" },
  { href: "/audit", label: "Audit", description: "Operator and system action log", icon: History, group: "Admin" },
  { href: "/incidents", label: "Incidents", description: "Active incidents and timeline", icon: AlertTriangle, group: "Admin" },
  { href: "/", label: "Home", description: "Operations overview", icon: LayoutGrid, group: "Core" },
  { href: "/infra", label: "Infrastructure", description: "Hetzner, GPU, Vast, services", icon: Server, group: "Core" },
  { href: "/doctor", label: "Doctor", description: "Auto-repair history", icon: Stethoscope, group: "Core" },
  { href: "/models", label: "Models", description: "Model inventory and health", icon: Cpu, group: "Core" },
  { href: "/autopipeline", label: "Pipeline", description: "Editorial queue and stages", icon: Workflow, group: "Core" },
  { href: "/cost", label: "Cost", description: "Spend ledger and recommendations", icon: TrendingUp, group: "Core" },
  { href: "/gateway", label: "Gateway", description: "LLM routing and health", icon: Route, group: "Core" },
  { href: "/newsbites", label: "NewsBites", description: "Articles and deploys", icon: Newspaper, group: "Core" },
  { href: "/settings", label: "Settings", description: "System configuration", icon: Settings2, group: "Platform" },
  { href: "/builder", label: "Builder", description: "Agent build platform", icon: Hammer, group: "Platform" },
  { href: "/opencode", label: "OpenCode", description: "Agent sessions", icon: Terminal, group: "Platform" },
  { href: "/codex", label: "Codex", description: "Headless codex exec", icon: Code2, group: "Platform" },
  { href: "/claude", label: "Claude Code", description: "Claude session", icon: Sparkles, group: "Platform" },
  { href: "/litellm", label: "LiteLLM", description: "LiteLLM routing config", icon: Route, group: "Platform" },
  { href: "/content-health", label: "Content Health", description: "Editorial content quality", icon: FileCheck2, group: "Platform" },
];

// ── Executor actions catalog ──────────────────────────────────────────────────

type ActionItem = { id: string; label: string; description: string; risk: string };

const PALETTE_ACTIONS: ActionItem[] = [
  { id: "start-job:model-health:all", label: "Run model discovery", description: "Trigger model health check for all models", risk: "low" },
  { id: "doctor-scan", label: "Doctor scan now", description: "Run a fresh doctor scan", risk: "low" },
  { id: "insights-scan", label: "Refresh detections", description: "Scan all detectors now", risk: "low" },
];

// ── Search result types ─────────────────────────────────────────────────────

type SearchResults = {
  insights: Array<{ id: string; title: string; severity: string; domain: string; status: string; sourceKey: string | null }>;
  audit: Array<{ id: number; ts: number; actionKind: string; actor: string | null; target: string | null; result: string | null }>;
  jobs: Array<{ id: string; kind: string; state: string; ts: number | null }>;
};

// ── Palette item ─────────────────────────────────────────────────────────────

type PaletteItemKind = "route" | "action" | "finding" | "audit" | "job";

type PaletteItem = {
  kind: PaletteItemKind;
  id: string;
  label: string;
  description: string;
  href?: string;
  icon: typeof LayoutGrid;
  badge?: string;
  badgeColor?: string;
};

// ── Main CommandPalette component ────────────────────────────────────────────

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setResults(null);
      setActionMessage(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (query.trim().length < 2) { setResults(null); return; }
    setSearchLoading(true);
    searchTimer.current = setTimeout(() => {
      authFetch(`/api/admin/search?q=${encodeURIComponent(query.trim())}`)
        .then((r) => r.json() as Promise<{ data?: SearchResults }>)
        .then((d) => { setResults(d.data ?? null); setSearchLoading(false); })
        .catch(() => { setSearchLoading(false); });
    }, 280);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query]);

  const items = buildItems(query, results);

  useEffect(() => { setSelected(0); }, [query]);

  const activate = useCallback(async (item: PaletteItem) => {
    if (item.kind === "action") {
      setActionBusy(item.id);
      setActionMessage(null);
      try {
        let endpoint = "/api/actions/execute";
        let body: Record<string, unknown> = { actionId: item.id, reason: "Command palette", confirmed: true, params: {} };

        if (item.id === "insights-scan") {
          endpoint = "/api/insights/scan";
          body = {};
        } else if (item.id === "doctor-scan") {
          endpoint = "/api/doctor/scan";
          body = {};
        }

        const res = await authFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({})) as { data?: { message?: string }; error?: string };
        if (!res.ok) throw new Error(json.error ?? "Action failed");
        setActionMessage(json.data?.message ?? "Done.");
      } catch (err) {
        setActionMessage(err instanceof Error ? err.message : "Action failed.");
      } finally {
        setActionBusy(null);
      }
      return;
    }
    if (item.href) { navigate(item.href); onClose(); }
  }, [navigate, onClose]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, items.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    if (e.key === "Enter" && items[selected]) { e.preventDefault(); void activate(items[selected]); }
  }

  if (!open) return null;

  return (
    <div className="cmdpal-overlay" onClick={onClose}>
      <div className="cmdpal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="cmdpal-input-row">
          {searchLoading ? <Loader2 size={16} className="cmdpal-search-icon spin" /> : <Search size={16} className="cmdpal-search-icon" />}
          <input
            ref={inputRef}
            className="cmdpal-input"
            placeholder="Go to a page, run an action, or search findings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Command palette search"
            autoComplete="off"
          />
          <kbd className="cmdpal-esc" onClick={onClose}>Esc</kbd>
        </div>

        {actionMessage && (
          <div className="cmdpal-message">
            <CheckCircle2 size={13} />
            {actionMessage}
          </div>
        )}

        <div className="cmdpal-results" role="listbox">
          {items.length === 0 && query.length >= 2 && !searchLoading && (
            <div className="cmdpal-empty">No results for &ldquo;{query}&rdquo;</div>
          )}
          {items.map((item, idx) => {
            const Icon = item.icon;
            return (
              <button
                key={`${item.kind}-${item.id}`}
                type="button"
                role="option"
                aria-selected={idx === selected}
                className={`cmdpal-item${idx === selected ? " selected" : ""}`}
                onClick={() => void activate(item)}
                disabled={actionBusy === item.id}
              >
                <Icon size={15} strokeWidth={1.75} className="cmdpal-item-icon" />
                <div className="cmdpal-item-text">
                  <span className="cmdpal-item-label">{item.label}</span>
                  <span className="cmdpal-item-desc">{item.description}</span>
                </div>
                {item.badge && <span className={`pill ${item.badgeColor ?? "gray"}`}>{item.badge}</span>}
                {item.kind === "route" && <ArrowRight size={12} className="cmdpal-item-go" />}
                {item.kind === "action" && (
                  actionBusy === item.id ? <Loader2 size={13} className="spin" /> : <Play size={12} className="cmdpal-item-go" />
                )}
              </button>
            );
          })}
        </div>

        <div className="cmdpal-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function buildItems(query: string, results: SearchResults | null): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const items: PaletteItem[] = [];

  if (!q) {
    // Default: show admin routes first, then actions
    for (const r of ROUTES.filter((r) => r.group === "Admin").slice(0, 6)) {
      items.push({ kind: "route", id: r.href, label: r.label, description: r.description, href: r.href, icon: r.icon });
    }
    for (const a of PALETTE_ACTIONS) {
      items.push({ kind: "action", id: a.id, label: a.label, description: a.description, icon: Play, badge: a.risk, badgeColor: a.risk === "low" ? "green" : "amber" });
    }
    return items;
  }

  // Route matches
  for (const r of ROUTES) {
    if (r.label.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.href.includes(q)) {
      items.push({ kind: "route", id: r.href, label: r.label, description: r.description, href: r.href, icon: r.icon });
    }
  }

  // Action matches
  for (const a of PALETTE_ACTIONS) {
    if (a.label.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)) {
      items.push({ kind: "action", id: a.id, label: a.label, description: a.description, icon: Play, badge: a.risk, badgeColor: "green" });
    }
  }

  // Finding hits
  if (results?.insights) {
    for (const f of results.insights) {
      const href = f.sourceKey ? `/insights?focus=${encodeURIComponent(f.sourceKey)}` : `/insights`;
      items.push({
        kind: "finding",
        id: f.id,
        label: f.title,
        description: `${f.domain} · ${f.status}`,
        href,
        icon: Inbox,
        badge: f.severity,
        badgeColor: f.severity === "critical" || f.severity === "high" ? "red" : f.severity === "medium" ? "amber" : "gray",
      });
    }
  }

  // Audit hits
  if (results?.audit) {
    for (const a of results.audit) {
      items.push({
        kind: "audit",
        id: String(a.id),
        label: a.actionKind,
        description: `${a.actor ?? "system"} → ${a.target ?? "—"}`,
        href: "/audit",
        icon: History,
        badge: new Date(a.ts).toLocaleDateString(),
      });
    }
  }

  // Job hits
  if (results?.jobs) {
    for (const j of results.jobs) {
      items.push({
        kind: "job",
        id: j.id,
        label: j.kind,
        description: `${j.state} · ${j.id.slice(0, 8)}`,
        href: "/jobs",
        icon: Workflow,
        badge: j.state,
        badgeColor: j.state === "success" ? "green" : j.state === "failed" ? "red" : "gray",
      });
    }
  }

  return items.slice(0, 15);
}

// ── Hook to wire Ctrl/Cmd-K globally ─────────────────────────────────────────

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return { open, onClose: () => setOpen(false) };
}
