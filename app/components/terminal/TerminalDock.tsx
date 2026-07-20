import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronUp, TerminalSquare } from "lucide-react";
import { useAuthenticatedApi } from "../../hooks/useAuthenticatedApi";
import { useTenantContext } from "../../hooks/useTenantContext";
import {
  LEGACY_TAB_ID,
  defaultWorkspaceLayout,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
  toTerminalSummaries,
  workspaceLayoutStorageKey,
} from "../../lib/terminalWorkspace";
import type { ManagedTerminal } from "../../../server/terminal/multiSession";

function readDockCollapsed(tenantId: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const layout = parseWorkspaceLayout(localStorage.getItem(workspaceLayoutStorageKey(tenantId)));
    return layout?.dockCollapsed ?? false;
  } catch {
    return false;
  }
}

function writeDockCollapsed(tenantId: string, collapsed: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    const key = workspaceLayoutStorageKey(tenantId);
    const current = parseWorkspaceLayout(localStorage.getItem(key)) ?? defaultWorkspaceLayout();
    localStorage.setItem(key, serializeWorkspaceLayout({ ...current, dockCollapsed: collapsed }));
  } catch {
    // storage denied or unavailable (e.g. private browsing) — collapse state stays in-memory only.
  }
}

export function TerminalDock() {
  const { tenantId } = useTenantContext();
  const { data } = useAuthenticatedApi<{ terminals: ManagedTerminal[]; count: number }>("/api/terminal/sessions");
  const [collapsed, setCollapsed] = useState(() => readDockCollapsed(tenantId));

  useEffect(() => {
    setCollapsed(readDockCollapsed(tenantId));
  }, [tenantId]);

  const summaries = data ? toTerminalSummaries(data.terminals) : [];

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      writeDockCollapsed(tenantId, next);
      return next;
    });
  }

  return (
    <div className={`terminal-dock${collapsed ? " terminal-dock-collapsed" : ""}`}>
      <button
        type="button"
        className="terminal-dock-toggle"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand terminal dock" : "Collapse terminal dock"}
      >
        <TerminalSquare size={14} />
        <span>Terminals{summaries.length > 0 ? ` (${summaries.length})` : ""}</span>
        {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {!collapsed && (
        <div className="terminal-dock-list">
          {summaries.length === 0 ? (
            <div className="terminal-dock-empty">No terminals open. Visit Terminal to start one.</div>
          ) : (
            summaries.map((summary) => (
              <Link
                key={summary.id}
                href={`/terminal?open=${encodeURIComponent(summary.legacy ? LEGACY_TAB_ID : summary.id)}`}
                className="terminal-dock-row"
              >
                <span
                  className={`terminal-dock-alive ${summary.alive === null ? "unknown" : summary.alive ? "alive" : "dead"}`}
                  aria-hidden="true"
                >
                  ●
                </span>
                <span className="terminal-dock-title">{summary.title}</span>
                <span className="terminal-dock-kind">{summary.legacy ? "legacy" : "managed"}</span>
              </Link>
            ))
          )}
          <div className="terminal-dock-note">
            Live attach and writer status are only visible inside an open terminal pane — the dock never opens a
            connection of its own.
          </div>
        </div>
      )}
    </div>
  );
}
