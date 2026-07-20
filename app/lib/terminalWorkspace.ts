export type TerminalTabKind = "legacy" | "managed";

/** One entry in the local, per-tenant persisted layout. `id` is the frontend's own tab
 *  identity: the literal "legacy" sentinel for the singleton legacy tab (never a registry id —
 *  the legacy pane never attaches by id), or the managed AgentSession.id for everything else. */
export type TerminalTab = { kind: TerminalTabKind; id: string };

export type SplitLayout = "single" | "split-h" | "split-v";

export type WorkspaceLayout = {
  version: 1;
  openTabs: TerminalTab[];
  activeTabId: string;
  splitLayout: SplitLayout;
  paneBTabId: string | null;
  dockCollapsed: boolean;
};

export const LEGACY_TAB_ID = "legacy";
export const LEGACY_TAB: TerminalTab = { kind: "legacy", id: LEGACY_TAB_ID };

/** Mirrors MAX_MANAGED_CONNECTIONS in server/terminal/multiplexer.ts:22. That module is
 *  server-only and does not export the constant; keep this value manually in sync rather than
 *  importing across the server/client boundary. */
export const MAX_MANAGED_WS_CONNECTIONS = 6;

export function defaultWorkspaceLayout(): WorkspaceLayout {
  return {
    version: 1,
    openTabs: [LEGACY_TAB],
    activeTabId: LEGACY_TAB_ID,
    splitLayout: "single",
    paneBTabId: null,
    dockCollapsed: false,
  };
}

export function workspaceLayoutStorageKey(tenantId: string): string {
  return `cs-terminal-workspace-layout:${tenantId}`;
}

function isTerminalTab(value: unknown): value is TerminalTab {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.kind === "legacy" || candidate.kind === "managed") && typeof candidate.id === "string";
}

function isSplitLayout(value: unknown): value is SplitLayout {
  return value === "single" || value === "split-h" || value === "split-v";
}

/** Returns null (never throws) on missing/malformed/wrong-version storage content. */
export function parseWorkspaceLayout(raw: string | null): WorkspaceLayout | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1) return null;
  if (!Array.isArray(candidate.openTabs) || !candidate.openTabs.every(isTerminalTab)) return null;
  if (typeof candidate.activeTabId !== "string") return null;
  if (!isSplitLayout(candidate.splitLayout)) return null;
  if (candidate.paneBTabId !== null && typeof candidate.paneBTabId !== "string") return null;
  if (typeof candidate.dockCollapsed !== "boolean") return null;
  return {
    version: 1,
    openTabs: candidate.openTabs as TerminalTab[],
    activeTabId: candidate.activeTabId,
    splitLayout: candidate.splitLayout,
    paneBTabId: candidate.paneBTabId as string | null,
    dockCollapsed: candidate.dockCollapsed,
  };
}

export function serializeWorkspaceLayout(layout: WorkspaceLayout): string {
  return JSON.stringify(layout);
}

/** The roster shape the tab strip and dock both consume, derived from GET /api/terminal/sessions. */
export type ManagedTerminalSummary = {
  id: string;
  title: string;
  alive: boolean | null;
  legacy: boolean; // effectiveConfig.legacy === true
  archived: boolean; // archivedAt !== null
};

export function toTerminalSummaries(terminals: Array<{
  session: { id: string; title: string; effectiveConfig: Record<string, unknown>; archivedAt: number | null };
  alive: boolean | null;
}>): ManagedTerminalSummary[] {
  return terminals.map((terminal) => ({
    id: terminal.session.id,
    title: terminal.session.title,
    alive: terminal.alive,
    legacy: terminal.session.effectiveConfig.legacy === true,
    archived: terminal.session.archivedAt !== null,
  }));
}

/**
 * Reconciles a locally persisted layout against the live roster. Rules:
 * - The legacy tab is always kept; it does not need a roster entry to remain open (the legacy
 *   pane works from its own fixed endpoints regardless of registry state), but if `known`
 *   contains a legacy summary, dock-eligibility follows it.
 * - Any "managed" tab whose id is not present, or is archived, in `known` is dropped.
 * - If activeTabId no longer refers to an open tab, fall back to the first remaining open tab
 *   (or LEGACY_TAB_ID if openTabs would otherwise be empty — it is never removed).
 * - If paneBTabId no longer refers to an open tab, clear it and fall back splitLayout to "single".
 * - Never introduces a tab that wasn't already open; this function only prunes/repairs, it does
 *   not add tabs for every roster entry (that would silently reopen terminals the operator closed).
 */
export function reconcileWorkspaceLayout(layout: WorkspaceLayout, known: ManagedTerminalSummary[]): WorkspaceLayout {
  const knownById = new Map(known.map((summary) => [summary.id, summary]));

  const prunedTabs = layout.openTabs.filter((tab) => {
    if (tab.kind === "legacy") return true;
    const summary = knownById.get(tab.id);
    if (!summary) return false;
    if (summary.archived) return false;
    return true;
  });

  const openTabs = prunedTabs.some((tab) => tab.kind === "legacy") ? prunedTabs : [LEGACY_TAB, ...prunedTabs];

  const activeStillOpen = openTabs.some((tab) => tab.id === layout.activeTabId);
  const activeTabId = activeStillOpen ? layout.activeTabId : (openTabs[0]?.id ?? LEGACY_TAB_ID);

  const paneBStillOpen = layout.paneBTabId !== null && openTabs.some((tab) => tab.id === layout.paneBTabId);
  const paneBTabId = paneBStillOpen ? layout.paneBTabId : null;
  const splitLayout = paneBStillOpen ? layout.splitLayout : "single";

  return {
    version: 1,
    openTabs,
    activeTabId,
    splitLayout,
    paneBTabId,
    dockCollapsed: layout.dockCollapsed,
  };
}

/** True while below the global managed-connection budget this browser session is aware of. */
export function canOpenAdditionalConnection(currentlyOpenManagedConnections: number): boolean {
  return currentlyOpenManagedConnections < MAX_MANAGED_WS_CONNECTIONS;
}
