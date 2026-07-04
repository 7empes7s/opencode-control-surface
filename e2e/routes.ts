// Every static route in app/App.tsx (param/wildcard routes excluded; "/" is the
// catch-all DashHome). Keep in sync with the router — a missing entry here means
// a page ships with zero viewport/UI-audit coverage.
//
// Shared by e2e/multi-viewport.pw.ts (chromium-desktop/tablet/mobile against the
// live/dev server) and e2e/fresh-host/ui-audit.pw.ts (chromium desktop against
// the fresh-host container) — extracted so both suites stay in lockstep instead
// of drifting apart.
export const ROUTES = [
  "/",
  "/status",
  "/opencode",
  "/codex",
  "/claude",
  "/gemini",
  "/admin",
  "/autopipeline",
  "/insights",
  "/security",
  "/agents",
  "/scout",
  "/doctor",
  "/models",
  "/litellm",
  "/newsbites",
  "/infra",
  "/incidents",
  "/jobs",
  "/agent-team",
  "/audit",
  "/today",
  "/settings",
  "/builder",
  "/brainstorm",
  "/governance",
  "/traces",
  "/gateway",
  "/workflows",
  "/projects",
  "/about",
  "/marketplace",
  "/install",
  "/cost",
  "/finance-intel",
  "/channels",
  "/content-health",
  "/reports",
  "/data-explorer",
  "/compliance",
  "/feature-flags",
];
