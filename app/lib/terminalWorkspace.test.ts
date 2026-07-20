import { describe, expect, test } from "bun:test";
import {
  LEGACY_TAB,
  LEGACY_TAB_ID,
  MAX_MANAGED_WS_CONNECTIONS,
  canOpenAdditionalConnection,
  defaultWorkspaceLayout,
  parseWorkspaceLayout,
  reconcileWorkspaceLayout,
  serializeWorkspaceLayout,
  toTerminalSummaries,
  workspaceLayoutStorageKey,
  type ManagedTerminalSummary,
  type WorkspaceLayout,
} from "./terminalWorkspace";

describe("defaultWorkspaceLayout", () => {
  test("includes the legacy tab and starts in single layout", () => {
    const layout = defaultWorkspaceLayout();
    expect(layout.openTabs).toEqual([LEGACY_TAB]);
    expect(layout.activeTabId).toBe(LEGACY_TAB_ID);
    expect(layout.splitLayout).toBe("single");
    expect(layout.version).toBe(1);
    expect(layout.paneBTabId).toBeNull();
    expect(layout.dockCollapsed).toBe(false);
  });
});

describe("parseWorkspaceLayout", () => {
  test("returns null for null input", () => {
    expect(parseWorkspaceLayout(null)).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseWorkspaceLayout("{not valid json")).toBeNull();
  });

  test("returns null for a wrong version", () => {
    const payload = JSON.stringify({
      version: 2,
      openTabs: [LEGACY_TAB],
      activeTabId: LEGACY_TAB_ID,
      splitLayout: "single",
      paneBTabId: null,
      dockCollapsed: false,
    });
    expect(parseWorkspaceLayout(payload)).toBeNull();
  });

  test("returns null for a payload missing a required field", () => {
    const payload = JSON.stringify({
      version: 1,
      openTabs: [LEGACY_TAB],
      activeTabId: LEGACY_TAB_ID,
      splitLayout: "single",
      paneBTabId: null,
      // dockCollapsed intentionally omitted
    });
    expect(parseWorkspaceLayout(payload)).toBeNull();
  });

  test("round-trips a valid layout through serializeWorkspaceLayout", () => {
    const layout: WorkspaceLayout = {
      version: 1,
      openTabs: [LEGACY_TAB, { kind: "managed", id: "abc-123" }],
      activeTabId: "abc-123",
      splitLayout: "split-h",
      paneBTabId: "abc-123",
      dockCollapsed: true,
    };
    const raw = serializeWorkspaceLayout(layout);
    expect(parseWorkspaceLayout(raw)).toEqual(layout);
  });
});

describe("toTerminalSummaries", () => {
  test("maps legacy, archived, and alive fields correctly", () => {
    const input = [
      {
        session: { id: "t1", title: "One", effectiveConfig: { legacy: true }, archivedAt: null },
        alive: true,
      },
      {
        session: { id: "t2", title: "Two", effectiveConfig: { legacy: false }, archivedAt: 1700000000000 },
        alive: false,
      },
      {
        session: { id: "t3", title: "Three", effectiveConfig: {}, archivedAt: null },
        alive: null,
      },
    ];

    expect(toTerminalSummaries(input)).toEqual([
      { id: "t1", title: "One", alive: true, legacy: true, archived: false },
      { id: "t2", title: "Two", alive: false, legacy: false, archived: true },
      { id: "t3", title: "Three", alive: null, legacy: false, archived: false },
    ]);
  });
});

describe("reconcileWorkspaceLayout", () => {
  function summary(overrides: Partial<ManagedTerminalSummary> & { id: string }): ManagedTerminalSummary {
    return {
      title: overrides.id,
      alive: true,
      legacy: false,
      archived: false,
      ...overrides,
    };
  }

  test("drops a managed tab absent from known", () => {
    const layout: WorkspaceLayout = {
      version: 1,
      openTabs: [LEGACY_TAB, { kind: "managed", id: "a" }],
      activeTabId: LEGACY_TAB_ID,
      splitLayout: "single",
      paneBTabId: null,
      dockCollapsed: false,
    };
    const result = reconcileWorkspaceLayout(layout, []);
    expect(result.openTabs).toEqual([LEGACY_TAB]);
  });

  test("drops an archived managed tab even if present in known", () => {
    const layout: WorkspaceLayout = {
      version: 1,
      openTabs: [LEGACY_TAB, { kind: "managed", id: "a" }],
      activeTabId: LEGACY_TAB_ID,
      splitLayout: "single",
      paneBTabId: null,
      dockCollapsed: false,
    };
    const result = reconcileWorkspaceLayout(layout, [summary({ id: "a", archived: true })]);
    expect(result.openTabs).toEqual([LEGACY_TAB]);
  });

  test("never drops the legacy tab even when known has no legacy summary", () => {
    const layout: WorkspaceLayout = {
      version: 1,
      openTabs: [LEGACY_TAB],
      activeTabId: LEGACY_TAB_ID,
      splitLayout: "single",
      paneBTabId: null,
      dockCollapsed: false,
    };
    const result = reconcileWorkspaceLayout(layout, []);
    expect(result.openTabs).toEqual([LEGACY_TAB]);
  });

  test("falls back activeTabId to a remaining open tab when the active tab was dropped", () => {
    const layout: WorkspaceLayout = {
      version: 1,
      openTabs: [
        { kind: "managed", id: "a" },
        { kind: "managed", id: "b" },
        LEGACY_TAB,
      ],
      activeTabId: "a",
      splitLayout: "single",
      paneBTabId: null,
      dockCollapsed: false,
    };
    const result = reconcileWorkspaceLayout(layout, [summary({ id: "b", archived: false })]);
    expect(result.openTabs).toEqual([{ kind: "managed", id: "b" }, LEGACY_TAB]);
    expect(result.activeTabId).toBe("b");
  });

  test("falls back activeTabId to LEGACY_TAB_ID when the active tab was dropped and no other tab remains", () => {
    const layout: WorkspaceLayout = {
      version: 1,
      openTabs: [LEGACY_TAB, { kind: "managed", id: "a" }],
      activeTabId: "a",
      splitLayout: "single",
      paneBTabId: null,
      dockCollapsed: false,
    };
    const result = reconcileWorkspaceLayout(layout, []);
    expect(result.openTabs).toEqual([LEGACY_TAB]);
    expect(result.activeTabId).toBe(LEGACY_TAB_ID);
  });

  test("clears paneBTabId and resets splitLayout to single when pane B's tab was dropped", () => {
    const layout: WorkspaceLayout = {
      version: 1,
      openTabs: [LEGACY_TAB, { kind: "managed", id: "a" }, { kind: "managed", id: "b" }],
      activeTabId: LEGACY_TAB_ID,
      splitLayout: "split-h",
      paneBTabId: "b",
      dockCollapsed: false,
    };
    const result = reconcileWorkspaceLayout(layout, [summary({ id: "a", archived: false })]);
    expect(result.paneBTabId).toBeNull();
    expect(result.splitLayout).toBe("single");
  });

  test("never adds a tab that wasn't already in openTabs", () => {
    const layout: WorkspaceLayout = {
      version: 1,
      openTabs: [LEGACY_TAB],
      activeTabId: LEGACY_TAB_ID,
      splitLayout: "single",
      paneBTabId: null,
      dockCollapsed: false,
    };
    const result = reconcileWorkspaceLayout(layout, [summary({ id: "z", archived: false })]);
    expect(result.openTabs).toEqual([LEGACY_TAB]);
  });
});

describe("canOpenAdditionalConnection", () => {
  test("true below MAX_MANAGED_WS_CONNECTIONS", () => {
    expect(canOpenAdditionalConnection(MAX_MANAGED_WS_CONNECTIONS - 1)).toBe(true);
  });

  test("false at MAX_MANAGED_WS_CONNECTIONS", () => {
    expect(canOpenAdditionalConnection(MAX_MANAGED_WS_CONNECTIONS)).toBe(false);
  });

  test("false above MAX_MANAGED_WS_CONNECTIONS", () => {
    expect(canOpenAdditionalConnection(MAX_MANAGED_WS_CONNECTIONS + 1)).toBe(false);
  });
});

describe("workspaceLayoutStorageKey", () => {
  test("produces a distinct key per tenant id", () => {
    const keyA = workspaceLayoutStorageKey("tenant-a");
    const keyB = workspaceLayoutStorageKey("tenant-ab");
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("cs-terminal-workspace-layout:tenant-a");
    expect(keyB).toBe("cs-terminal-workspace-layout:tenant-ab");
  });
});
