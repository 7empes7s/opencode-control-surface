import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { TerminalPage } from "./TerminalPage";
import { ManagedTerminalPane } from "../components/terminal/ManagedTerminalPane";
import { TerminalTabStrip } from "../components/terminal/TerminalTabStrip";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { useTenantContext } from "../hooks/useTenantContext";
import {
  LEGACY_TAB,
  LEGACY_TAB_ID,
  canOpenAdditionalConnection,
  defaultWorkspaceLayout,
  parseWorkspaceLayout,
  reconcileWorkspaceLayout,
  serializeWorkspaceLayout,
  toTerminalSummaries,
  workspaceLayoutStorageKey,
} from "../lib/terminalWorkspace";
import type { SplitLayout, TerminalTab, WorkspaceLayout } from "../lib/terminalWorkspace";
import type { ManagedTerminal } from "../../server/terminal/multiSession";
import "./TerminalWorkspacePage.css";

function loadLayout(tenantId: string): WorkspaceLayout {
  try {
    if (typeof localStorage === "undefined") return defaultWorkspaceLayout();
    return parseWorkspaceLayout(localStorage.getItem(workspaceLayoutStorageKey(tenantId))) ?? defaultWorkspaceLayout();
  } catch {
    return defaultWorkspaceLayout();
  }
}

function persistLayout(tenantId: string, layout: WorkspaceLayout): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(workspaceLayoutStorageKey(tenantId), serializeWorkspaceLayout(layout));
  } catch {
    // storage denied or unavailable (e.g. private browsing) — layout stays in-memory only.
  }
}

function nextSplit(current: SplitLayout): SplitLayout {
  if (current === "single") return "split-h";
  if (current === "split-h") return "split-v";
  return "single";
}

export function TerminalWorkspacePage() {
  const { tenantId } = useTenantContext();
  const [layout, setLayout] = useState<WorkspaceLayout>(() => loadLayout(tenantId));

  const { data } = useAuthenticatedApi<{ terminals: ManagedTerminal[]; count: number }>("/api/terminal/sessions");
  const roster = data ? toTerminalSummaries(data.terminals) : [];

  const search = useSearch();
  const [, navigate] = useLocation();
  const appliedSearchRef = useRef(false);

  const updateLayout = useCallback((updater: (current: WorkspaceLayout) => WorkspaceLayout) => {
    setLayout((current) => {
      const next = updater(current);
      persistLayout(tenantId, next);
      return next;
    });
  }, [tenantId]);

  // Reconcile the persisted layout against the live roster on every poll; skip the write when
  // nothing actually changed so this doesn't churn localStorage/renders every interval tick.
  useEffect(() => {
    if (!data) return;
    setLayout((current) => {
      const reconciled = reconcileWorkspaceLayout(current, roster);
      if (serializeWorkspaceLayout(reconciled) === serializeWorkspaceLayout(current)) return current;
      persistLayout(tenantId, reconciled);
      return reconciled;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tenantId]);

  // Deep-link from the dock: ?open=<id> opens/activates a tab once, then clears the param so a
  // refresh doesn't re-trigger it.
  useEffect(() => {
    if (appliedSearchRef.current) return;
    if (!data) return; // wait for the roster so a managed id can be validated
    const params = new URLSearchParams(search);
    const openId = params.get("open");
    appliedSearchRef.current = true;
    if (!openId) return;
    const isKnown = openId === LEGACY_TAB_ID || roster.some((summary) => summary.id === openId && !summary.archived);
    if (isKnown) {
      updateLayout((current) => {
        const tab: TerminalTab = openId === LEGACY_TAB_ID ? LEGACY_TAB : { kind: "managed", id: openId };
        const openTabs = current.openTabs.some((existing) => existing.id === tab.id)
          ? current.openTabs
          : [...current.openTabs, tab];
        return { ...current, openTabs, activeTabId: tab.id };
      });
    }
    navigate("/terminal", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search]);

  const mountedManagedCount = [layout.activeTabId, layout.splitLayout !== "single" ? layout.paneBTabId : null]
    .filter((id): id is string => id !== null && id !== LEGACY_TAB_ID).length;
  const canOpenSplitPane = canOpenAdditionalConnection(mountedManagedCount);

  function selectTab(id: string) {
    updateLayout((current) => ({ ...current, activeTabId: id }));
  }
  function selectPaneB(id: string) {
    updateLayout((current) => ({ ...current, paneBTabId: id }));
  }
  function closeTab(id: string) {
    updateLayout((current) => {
      const openTabs = current.openTabs.filter((tab) => tab.id !== id);
      const nextOpenTabs = openTabs.length > 0 ? openTabs : [LEGACY_TAB];
      const activeTabId = current.activeTabId === id ? (nextOpenTabs[0]?.id ?? LEGACY_TAB_ID) : current.activeTabId;
      const paneBTabId = current.paneBTabId === id ? null : current.paneBTabId;
      const splitLayout = paneBTabId === null && current.paneBTabId !== null ? "single" : current.splitLayout;
      return { ...current, openTabs: nextOpenTabs, activeTabId, paneBTabId, splitLayout };
    });
  }
  function createTab(terminal: { id: string; title: string }) {
    updateLayout((current) => {
      const tab: TerminalTab = { kind: "managed", id: terminal.id };
      const openTabs = current.openTabs.some((existing) => existing.id === tab.id)
        ? current.openTabs
        : [...current.openTabs, tab];
      return { ...current, openTabs, activeTabId: tab.id };
    });
  }
  function reopenLegacy() {
    updateLayout((current) => {
      if (current.openTabs.some((tab) => tab.id === LEGACY_TAB_ID)) return current;
      return { ...current, openTabs: [LEGACY_TAB, ...current.openTabs], activeTabId: LEGACY_TAB_ID };
    });
  }
  function toggleSplit() {
    updateLayout((current) => {
      const proposed = nextSplit(current.splitLayout);
      if (proposed === "single") return { ...current, splitLayout: "single", paneBTabId: null };
      if (current.paneBTabId === null && !canOpenSplitPane) return current;
      const paneBTabId = current.paneBTabId
        ?? current.openTabs.find((tab) => tab.id !== current.activeTabId)?.id
        ?? current.activeTabId;
      return { ...current, splitLayout: proposed, paneBTabId };
    });
  }

  function renderPane(tabId: string, key: string) {
    if (tabId === LEGACY_TAB_ID) return <TerminalPage key={key} />;
    const summary = roster.find((entry) => entry.id === tabId);
    return <ManagedTerminalPane key={key} terminalId={tabId} title={summary?.title ?? "Terminal"} />;
  }

  return (
    <div className="terminal-workspace">
      <TerminalTabStrip
        openTabs={layout.openTabs}
        activeTabId={layout.activeTabId}
        paneBTabId={layout.paneBTabId}
        splitLayout={layout.splitLayout}
        roster={roster}
        canOpenSplitPane={canOpenSplitPane}
        onSelectTab={selectTab}
        onSelectPaneB={selectPaneB}
        onCloseTab={closeTab}
        onStopTab={closeTab}
        onCreateTab={createTab}
        onReopenLegacy={reopenLegacy}
        onToggleSplit={toggleSplit}
      />
      <div className={`terminal-workspace-canvas ${layout.splitLayout}`}>
        {renderPane(layout.activeTabId, "pane-a")}
        {layout.splitLayout !== "single" && layout.paneBTabId && renderPane(layout.paneBTabId, "pane-b")}
      </div>
    </div>
  );
}
