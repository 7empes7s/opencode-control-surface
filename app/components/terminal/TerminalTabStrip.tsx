import { useState } from "react";
import { Columns2, Plus, Rows2, Square, SquareStack, X } from "lucide-react";
import { ConfirmModal } from "../ConfirmModal";
import { authFetch } from "../../lib/authFetch";
import { LEGACY_TAB_ID } from "../../lib/terminalWorkspace";
import type { ManagedTerminalSummary, SplitLayout, TerminalTab } from "../../lib/terminalWorkspace";

type Props = {
  openTabs: TerminalTab[];
  activeTabId: string;
  paneBTabId: string | null;
  splitLayout: SplitLayout;
  roster: ManagedTerminalSummary[];
  canOpenSplitPane: boolean;
  onSelectTab: (id: string) => void;
  onSelectPaneB: (id: string) => void;
  onCloseTab: (id: string) => void;
  onStopTab: (id: string) => void;
  onCreateTab: (terminal: { id: string; title: string }) => void;
  onReopenLegacy: () => void;
  onToggleSplit: () => void;
};

function AliveDot({ alive }: { alive: boolean | null }) {
  if (alive === null) return <span className="terminal-workspace-alive-dot unknown" title="Liveness not probed">–</span>;
  return (
    <span className={`terminal-workspace-alive-dot ${alive ? "alive" : "dead"}`} title={alive ? "Alive" : "Not responding"}>
      ●
    </span>
  );
}

function rosterSummary(roster: ManagedTerminalSummary[], tab: TerminalTab): ManagedTerminalSummary | undefined {
  return roster.find((entry) => entry.id === tab.id);
}

function splitIcon(splitLayout: SplitLayout) {
  if (splitLayout === "split-h") return <Columns2 size={14} />;
  if (splitLayout === "split-v") return <Rows2 size={14} />;
  return <Square size={14} />;
}

export function TerminalTabStrip({
  openTabs,
  activeTabId,
  paneBTabId,
  splitLayout,
  roster,
  canOpenSplitPane,
  onSelectTab,
  onSelectPaneB,
  onCloseTab,
  onStopTab,
  onCreateTab,
  onReopenLegacy,
  onToggleSplit,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<TerminalTab | null>(null);
  const [stopLoading, setStopLoading] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const legacyOpen = openTabs.some((tab) => tab.id === LEGACY_TAB_ID);

  async function submitCreate(title?: string) {
    if (!title) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      const response = await authFetch("/api/terminal/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const body = await response.json().catch(() => ({})) as { data?: { terminal: { session: { id: string; title: string } } }; error?: string };
      if (!response.ok || !body.data) {
        setCreateError(body.error || `HTTP ${response.status}`);
        return;
      }
      onCreateTab({ id: body.data.terminal.session.id, title: body.data.terminal.session.title });
      setCreating(false);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "failed to create terminal");
    } finally {
      setCreateLoading(false);
    }
  }

  async function submitStop() {
    if (!stopTarget) return;
    setStopLoading(true);
    setStopError(null);
    try {
      const response = await authFetch(`/api/terminal/sessions/${encodeURIComponent(stopTarget.id)}/stop`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setStopError(body.error || `HTTP ${response.status}`);
        return;
      }
      onStopTab(stopTarget.id);
      setStopTarget(null);
    } catch (cause) {
      setStopError(cause instanceof Error ? cause.message : "failed to stop terminal");
    } finally {
      setStopLoading(false);
    }
  }

  return (
    <div className="terminal-tabstrip">
      <div className="terminal-tabstrip-tabs" role="tablist">
        {openTabs.map((tab) => {
          const summary = tab.kind === "managed" ? rosterSummary(roster, tab) : undefined;
          const label = tab.kind === "legacy" ? "Root shell" : summary?.title ?? "Terminal";
          const isActive = tab.id === activeTabId;
          const isPaneB = splitLayout !== "single" && tab.id === paneBTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              className={`terminal-tabstrip-tab${isActive ? " active" : ""}${isPaneB ? " pane-b" : ""}`}
            >
              <button
                type="button"
                className="terminal-tabstrip-tab-select"
                onClick={() => onSelectTab(tab.id)}
                title={label}
              >
                <AliveDot alive={tab.kind === "legacy" ? null : summary?.alive ?? null} />
                <span className="terminal-tabstrip-tab-label">{label}</span>
              </button>
              {splitLayout !== "single" && (
                <button
                  type="button"
                  className="terminal-tabstrip-paneb-btn"
                  title="Show in second pane"
                  onClick={() => onSelectPaneB(tab.id)}
                >
                  B
                </button>
              )}
              {tab.kind === "managed" && (
                <button
                  type="button"
                  className="terminal-tabstrip-stop-btn"
                  title="Stop terminal"
                  onClick={() => { setStopTarget(tab); setStopError(null); }}
                >
                  <SquareStack size={12} />
                </button>
              )}
              <button
                type="button"
                className="terminal-tabstrip-close-btn"
                title="Close tab (keeps the session running)"
                onClick={() => onCloseTab(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="terminal-tabstrip-actions">
        <button
          type="button"
          className="terminal-tabstrip-split-btn"
          title={canOpenSplitPane || splitLayout !== "single" ? "Cycle split layout" : "Managed connection budget reached — close a terminal to split"}
          onClick={onToggleSplit}
          disabled={splitLayout === "single" && !canOpenSplitPane}
        >
          {splitIcon(splitLayout)}
        </button>
        <div className="terminal-tabstrip-new-wrap">
          <button
            type="button"
            className="terminal-tabstrip-new-btn"
            title="New tab"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Plus size={14} />
          </button>
          {menuOpen && (
            <div className="terminal-tabstrip-new-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); setCreating(true); setCreateError(null); }}
              >
                New managed terminal
              </button>
              {!legacyOpen && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); onReopenLegacy(); }}
                >
                  Reopen root shell
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {creating && (
        <ConfirmModal
          title="New managed terminal"
          inputLabel="Title"
          inputPlaceholder="e.g. build watcher"
          confirmLabel="Create"
          loading={createLoading}
          error={createError}
          onConfirm={(value) => void submitCreate(value)}
          onCancel={() => setCreating(false)}
        />
      )}

      {stopTarget && (
        <ConfirmModal
          title="Stop terminal?"
          message={`This terminates the tmux session for "${stopTarget.kind === "managed" ? rosterSummary(roster, stopTarget)?.title ?? "this terminal" : "this terminal"}" and cannot be undone.`}
          confirmLabel="Stop"
          danger
          loading={stopLoading}
          error={stopError}
          onConfirm={() => void submitStop()}
          onCancel={() => setStopTarget(null)}
        />
      )}
    </div>
  );
}
