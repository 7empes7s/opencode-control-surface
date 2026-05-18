# Control Surface — Phase 0: Stop the Bleeding

Source plan: `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md` § Phase 0 (lines 1669–1688)
Project root: `/opt/opencode-control-surface`
Last updated: 2026-05-17
Status: in progress

## Goal

Make the current product less confusing immediately. Core nav must contain only pages with real operator value. Unauthenticated states must be understandable. No native `confirm()/prompt()` dialogs in auth flows.

## Progress Tracking

- [x] P0-1: Move unready routes to labs/advanced — add `routeReadiness` registry (`core | advanced | labs | hidden`)
- [x] P0-2: Fix PRIMARY_NAV mobile — confirm mobile bottom nav shows OpenCode, not Marketplace
- [x] P0-3: Rename "TIB Builder" copy → "Control Surface" (except where specifically referring to Builder feature)
- [x] P0-4: Add "experimental" badge to Gateway, Governance, Compliance, Marketplace, Projects, Workflows, Traces, Setup, About
- [x] P0-5: Replace raw `fetch` with `authFetch` for protected UI actions (inventory: ProjectsPage, WorkflowsPage, BuilderPage, ClaudePage, CodexPage, NewsBitesPage)
- [x] P0-6: Add inline 401/403 handling — remove `window.prompt` / `window.confirm` from auth paths
- [x] P0-7: Disable or visually hide report-run buttons when not authenticated (check `/api/auth/status` on mount)
- [x] P0-8: `bun run typecheck` passes with zero errors after all changes

## Implementation Notes

### P0-1: Route readiness registry

Create a small registry in `app/routeReadiness.ts`:

```ts
export type RouteStatus = "core" | "advanced" | "labs" | "hidden";
export const ROUTE_READINESS: Record<string, RouteStatus> = {
  "/": "core",
  "/today": "core",
  "/autopipeline": "core",
  "/doctor": "core",
  "/models": "core",
  "/newsbites": "core",
  "/infra": "core",
  "/incidents": "core",
  "/jobs": "core",
  "/audit": "core",
  "/builder": "core",
  "/settings": "core",
  "/opencode": "core",
  "/codex": "core",
  "/claude": "core",
  "/gemini": "core",
  "/workflows": "advanced",
  "/marketplace": "labs",
  "/traces": "labs",
  "/gateway": "advanced",
  "/governance": "labs",
  "/compliance": "labs",
  "/projects": "advanced",
  "/about": "labs",
  "/install": "labs",
};
```

Use this in `DashSidebar.tsx` to filter the full `NAV` list. `core` routes always show. `advanced` routes show in a collapsed "Advanced" section. `labs` and `hidden` routes are excluded from nav entirely (still accessible by URL).

### P0-2: Mobile nav fix

In `DashSidebar.tsx`, the mobile bottom nav renders 5 items. Verify the 5 items are:
Home, Today (or Pipeline), Models (or Infra), Agents (OpenCode), Builder — **not** Marketplace.

Check what the mobile bottom-tab array uses vs PRIMARY_NAV and correct any mismatch.

### P0-3: Brand copy

`grep -rn "TIB Builder" app/ server/` — rename to "Control Surface" where it's used as the product name. Keep "Builder" (no TIB prefix) where it refers to the specific Builder feature (workflow runner).

### P0-4: Experimental badge

Add a small amber chip/badge (text "experimental" or "labs") beside the route label in the sidebar for `advanced` and `labs` routes. Reuse the existing badge component if available.

### P0-5: authFetch audit

Files already using `authFetch`: `BuilderPage.tsx`, `ClaudePage.tsx`, `CodexPage.tsx`. Files using raw `fetch` for protected calls: check `ProjectsPage.tsx`, `WorkflowsPage.tsx`, `NewsBitesPage.tsx`, and any component that calls `/api/...` with `fetch(...)` instead of `authFetch(...)`.

Replace raw `fetch` calls to protected API endpoints with `authFetch`. Import `authFetch` from `../lib/authFetch` (or wherever the module is).

### P0-6: 401/403 inline handling

Remove any `window.prompt("Enter operator token")` or `window.confirm(...)` in auth paths. Replace with inline error state: show a banner/callout "Session expired — please re-authenticate" with a link to the login flow (`/api/auth/session`).

### P0-7: Auth-gated action buttons

For pages that have "Run report" or "Generate" buttons that require auth: check `authStatus` on mount (GET `/api/auth/status`). If not authenticated, render the button as disabled with a tooltip "Authenticate to run".

## Validation

```bash
cd /opt/opencode-control-surface && bun run typecheck
cd /opt/opencode-control-surface && bun run build
cd /opt/opencode-control-surface && DASHBOARD_DB=1 bun test server/api/ server/db/
```

## Acceptance Criteria

- [x] Core nav contains only pages with real operator value (no Marketplace/Compliance/Governance in primary nav)
- [x] Mobile bottom nav shows OpenCode (or equivalent core agent page) — not Marketplace
- [x] "TIB Builder" string does not appear in UI copy (Builder feature keeps the name "Builder")  
- [x] Experimental badge visible on labs/advanced nav items
- [x] No `window.prompt()` or `window.confirm()` in auth paths
- [x] All protected fetch calls use `authFetch`
- [x] `bun run typecheck` passes
