# Dashboard V4 — Comprehensive Style & Parity Fix Plan

**Date:** 2026-05-13  
**Scope:** control.techinsiderbytes.com (`/opt/opencode-control-surface`)  
**Goal:** Fix all responsive layout issues, eliminate mobile overflow/overlap, unify agent-page functionality, and tighten desktop spacing.

---

## 1. Mobile Top Navigation Congestion

### Problem
On viewports `< 600 px`, the `.dash-topnav` renders **all 16 nav items** as icon-only buttons inside a single horizontally-scrollable `.topnav-links` strip. Even though text labels are hidden via `.topnav-link span { display: none }`, the sheer number of icons (plus brand, stack pill, theme toggles, variant toggles) makes the bar feel crushed and hard to tap accurately.

### Evidence
- `DashSidebar.tsx` lines 151-160: `NAV.map(...)` renders every route unconditionally.
- `globals.css` line 1853: `.topnav-link span { display: none }` only hides text; icons remain.

### Fix
1. **Add a mobile-only hamburger toggle** inside `.dash-topnav` that replaces the entire scrollable `.topnav-links` strip on small screens.
2. When the toggle is pressed, expand a **second full-width row** (`.topnav-links-expanded`) directly beneath the topnav containing all nav links as larger touch-targets (icon + label stacked or side-by-side).
3. Keep only the **primary 5 items** (`Home`, `Pipeline`, `Doctor`, `NewsBites`, `OpenCode`) visible in the compressed top bar on mobile, plus the hamburger.
4. Ensure the expanded row uses `flex-wrap: wrap` with `gap` so items flow naturally and never scroll horizontally.
5. Update `DashSidebar.tsx` state to manage `topnavExpanded` boolean.

### CSS Requirements
- `@media (max-width: 600px)`:
  - `.topnav-links { display: none; }`
  - `.topnav-links-expanded { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 14px; background: var(--bg-panel); border-bottom: 1px solid var(--border); }`
  - `.topnav-links-expanded .topnav-link { flex: 1 1 30%; min-height: 44px; justify-content: center; border-bottom: none; border-radius: 4px; }`

---

## 2. Tables Overflow Horizontally on Mobile

### Problem
Multiple pages contain wide tables that break the mobile viewport even with `overflow-x: auto` wrappers.

#### Affected tables
| Page | Table | Columns | Issue |
|------|-------|---------|-------|
| **Autopipeline** | Queue | 6+ | `.queue-col-priority`, `.queue-col-elapsed`, `.queue-col-flags` are hidden, but action buttons (`publish`, `rush`, `kill`) in a single `<td>` force min-width > viewport. |
| **Autopipeline** | Approvals | 3 | Usually okay, but long slug cells with `white-space: nowrap` cause spill. |
| **Models** | All models | 13 | Only 4 columns hidden on mobile; remaining 9 columns still overflow. Buttons in `<td style="display:flex">` add width. |
| **Builder** | Run detail passes | 7 | `seq`, `phase`, `agent`, `model`, `status`, `started`, `finished` — all `nowrap` headers. |
| **Builder** | Artifacts | 3 | Usually okay. |
| **Builder** | Validations | 6 | `command/url` + `error` cells can be very wide. |

### Evidence
- `globals.css` lines 1025-1042: `.table-wrap { overflow-x: auto; }` exists but inner tables have no `min-width` guard.
- `globals.css` lines 1981-1982: Only hides specific columns; no blanket mobile table strategy.
- `ModelsPage.tsx` line 152: Button group inside `<td>` uses `display: flex; gap: 4px` with no wrapping.

### Fix
1. **Add `table-layout: fixed` and `min-width: 100%` to `.data-table`** so it respects the wrapper and columns share space proportionally.
2. **Convert action-button cells to vertical stacking on mobile.** In `AutopipelinePage` queue table and `ModelsPage` action column, wrap button groups in a container that becomes `flex-direction: column` below 600 px.
3. **Aggressive column hiding on mobile** (`< 600 px`):
   - **Models table**: hide `pricing`, `type`, `CLI`, `ctx`, `rating` columns (keep `logical name`, `cap`, `quality`, `actions`).
   - **Builder passes table**: hide `started`, `finished`, `model` (keep `seq`, `phase`, `agent`, `status`).
   - **Builder validations table**: hide `started`, `finished` (keep `status`, `kind`, `command/url`, `error`).
4. **Ensure `.table-wrap` has `-webkit-overflow-scrolling: touch` and a visible scroll hint** (e.g., faint fade on right edge when scrollable).
5. **Wrap all builder detail tables** inside `.table-wrap` (currently some tables in `RunDetailPanel` are bare).

---

## 3. Collapsible Sections: Borders Remain When Content Hidden

### Problem
When a `SectionCard` or `CollapsibleSection` is collapsed, the outer border and border-radius remain, leaving an empty-looking framed box that used to be filled with data. This is visually jarring, especially on pages with many collapsed sections (Builder, Autopipeline).

### Evidence
- `SectionCard.tsx` line 23: `className="section-card"` always present; border comes from `.section-card` in CSS.
- `BuilderPage.tsx` lines 996-1008: `CollapsibleSection` applies inline `border: 1px solid var(--border)` and `border-radius: 8px` unconditionally.

### Fix
1. **For `SectionCard`:**
   - When `open === false`, remove the bottom border-radius or transition the card to a more compact "header-only" style.
   - Add `.section-card.closed { border-radius: 6px; opacity: 0.85; }` or similar to visually signal the collapsed state.
   - Optionally animate `max-height` (if performant) or simply fade the body.
2. **For `CollapsibleSection` in BuilderPage:**
   - Remove the inline `border` and `border-radius` from the wrapper div.
   - Use the same `.section-card` / `.section-card.closed` classes so behavior is unified across the app.
3. **Add a global helper** `.sc-closed { border-bottom: none; border-radius: 6px; }` applied dynamically when `open` is false.

---

## 4. Overlaying Buttons / Dialog Boxes Spilling on Mobile

### Problem
Several modal and overlay components exceed the mobile viewport or have internal elements that overlap:

#### A. Modals too wide
- `.modal-box.builder-workflow-modal` and `.modal-box.builder-detail-panel` are capped at `calc(100vw - 16px)` but their inner grids (`.builder-form-grid`, `.builder-picker-row`) still contain wide elements that force horizontal overflow inside the modal.
- `builder-detail-panel` contains tables that are not wrapped in `.table-wrap`.

#### B. Agent page topbar button overlap
- `GeminiPage`, `ClaudePage`, `CodexPage`: `oc-topbar` contains `oc-icon-btn` + `oc-topbar-titles` + `oc-model-btn` + `AgentVaultLogButton`. On narrow mobile viewports, the vault-log button can be pushed off-screen or overlap the model button because `oc-topbar` has `overflow: hidden` and no wrapping.

#### C. Permission bar buttons
- `.permission-btns` uses `display: flex; gap: 8px` without wrapping; on very small screens the two buttons (`allow`, `deny`) can overflow the `.permission-bar` max-width of 860 px (which becomes 100% on mobile).

### Fix
1. **Agent topbar wrapping:**
   - `@media (max-width: 767px)`: `.oc-topbar { flex-wrap: wrap; height: auto; min-height: 52px; padding: 6px 10px; }`
   - Ensure `.oc-model-btn` and `AgentVaultLogButton` wrap to a second row if needed, or hide the vault-log button label on mobile (icon only).
2. **Modal inner overflow:**
   - Force `.builder-form-grid` to `grid-template-columns: 1fr` below 768 px (already done at 600 px; extend to 768 px for tablets).
   - Wrap every table inside `RunDetailPanel` with `<div className="table-wrap">`.
   - Set `.builder-detail-panel .data-table { font-size: 11px; }` on mobile to reduce column width.
3. **Permission bar:**
   - `.permission-btns { flex-wrap: wrap; }`
   - `.perm-btn { flex: 1 1 40%; min-width: 120px; }`

---

## 5. Agent Page Functional Parity

### Problem
The four agent pages (`/gemini`, `/claude`, `/codex`, `/opencode`) do **not** share the same set of controls, creating an inconsistent operator experience.

| Feature | OpenCode | Codex | Claude | Gemini |
|---------|----------|-------|--------|--------|
| **Model picker** (clickable, opens modal) | Yes (`ModelPicker`) | No (static label) | No (static label) | No (static label) |
| **Runtime options bar** (model / approval / output) | No | No | No | Yes (`oc-runtime-bar`) |
| **Transcript controls** (all / messages / actions + filter chips) | Yes | Yes | No | No |
| **Vault log button** | Yes | Yes | Yes | Yes |
| **Attachment support** | Yes | No | No | No |
| **Permission banner** | Yes | N/A | N/A | N/A |

### Desired Uniform Feature Set
Every agent page should expose:
1. **Model picker** — a dropdown or modal to choose the active model. Gemini currently has a `<select>` in the runtime bar; OpenCode has a full modal. Standardize on a shared `ModelPicker` component (or a compact `<select>` if the backend supports model switching for that agent).
2. **Approval / effort mode picker** — `default`, `auto_edit`, `plan`, `yolo`. Gemini already has this; extend to Codex, Claude, and OpenCode if their backends support it.
3. **Transcript filter controls** (`TranscriptControls` component) — toggle between `all`, `messages`, `actions`, and filter by action type (`edits`, `deletes`, `commands`, `reads`, `web`, `errored`).
   - Claude and Gemini currently lack this entirely.
   - Claude messages are simple text; we can still filter by `system` vs `assistant` vs `user`, or by message length, or by error presence.
   - Gemini messages are also simple text; same approach.
4. **Output format picker** (where relevant) — `stream-json` vs `text`. Keep only on agents that support it (Gemini, possibly Codex).

### Fix
1. **Extract shared components:**
   - Create `AgentRuntimeBar.tsx` that accepts `model`, `approvalMode`, `outputFormat` props and renders the bar conditionally based on agent capabilities.
   - Create `AgentModelPicker.tsx` — a lightweight modal or dropdown that can be dropped into any agent page.
2. **Update each page:**
   - **GeminiPage:** Add `TranscriptControls`. Make the model `<select>` openable via the shared `AgentModelPicker` for consistency.
   - **ClaudePage:** Add `TranscriptControls` (mode: `all` / `messages` / `errors` since Claude has no structured actions). Add `AgentRuntimeBar` with at least model selection (if API supports it) and approval mode.
   - **CodexPage:** Already has `TranscriptControls`. Add `AgentModelPicker` and `AgentRuntimeBar` with model + approval mode.
   - **OpenCodeView:** Already has model picker and transcript controls. Add approval mode selector to `AgentRuntimeBar` if the OpenCode backend supports it.
3. **If an agent backend does NOT support a feature** (e.g., Claude model switching via the current API), the UI should still render the control in a **disabled / read-only** state with a tooltip explaining why, so the layout remains identical across pages.

---

## 6. Bootstrap ↔ Workflow Buttons Too Far Apart (Desktop)

### Problem
On the Builder page, the **"Bootstrap New Project"** button (top of the page) and the **workflow list** (bottom of the page) are visually disconnected. The user has to scroll a long distance between provisioning a new project and managing existing workflows.

### Evidence
- `BuilderPage.tsx` (not fully read, but inferred from user report and page structure): Bootstrap/provision UI is typically at the top, workflows further down.

### Fix
1. **Add a sticky action bar** or a **tab switcher** at the top of the Builder page:
   - Tab 1: "Workflows" (existing list)
   - Tab 2: "Bootstrap" (provision new project)
2. Alternatively, move the **"+ Bootstrap"** button into the same action row as the workflow list header so both actions are siblings.
3. Reduce vertical whitespace between the page header (`page-header`) and the first section card by tightening `.dash-page { padding-top: ... }` on desktop only if it feels excessive.

---

## 7. Missing Routes / Redirect Confusion

### Problem
Nav items exist for `/reports` and `/workflows` (and the user mentioned `/bootstrap`), but these routes are **not defined in `App.tsx`**. They fall through to the catch-all `<Route>` and render `DashHome`, which is confusing.

### Evidence
- `App.tsx` lines 46-104: No routes for `/reports`, `/workflows`, or `/bootstrap`.
- `DashSidebar.tsx` lines 38-54: `NAV` array includes routes that may not exist (the array has 16 items but App only registers 14-ish).

### Fix
1. **Audit `NAV` array** against registered routes.
2. Either:
   - **Remove** nav items for non-existent pages, OR
   - **Implement** the missing pages as lightweight placeholders (e.g., `/reports` could aggregate builder doctor reports; `/workflows` could alias `/builder`).
3. **Do not leave dead links** in the nav that silently render the homepage.

---

## 8. General CSS Hygiene

### A. `.dash-shell` grid mismatch
- `dash-shell` is defined as `grid-template-rows: 44px 1fr` but `.dash-main` is placed in `grid-row: 2; grid-column: 1 / -1;`. On mobile, when the bottom nav appears, the main area should account for the 56 px bottom bar. Currently padding is applied to `.dash-content` and `.dash-page`, but on chat pages (bare layout) the bottom nav is hidden — verify this doesn't leave unwanted dead space.

### B. Chat shell mobile bottom nav
- `.dash-shell:has(.dash-main.bare) .dash-bottomnav { display: none !important; }` correctly hides the bottom nav on agent pages. Confirm that agent pages do not also need `padding-bottom` compensation.

### C. `z-index` stacking
- `.modal-overlay` has `z-index: 9999`.
- `.drawer-overlay` has `z-index: 200`.
- `.oc-drawer-backdrop` has `z-index: 90`.
- Ensure that opening a modal from within a drawer (e.g., vault log modal inside agent drawer) does not get buried.

---

## 9. Model Picker Enhancement (Builder Workflow Modal)

### Problem
The `ModelSelect` in the Builder page new/edit workflow dialog is a plain HTML `<select>` with optgroups. It shows only a concatenated label string and gives the operator no visual signal about pricing, context window, modality support, or quality rating.

### Evidence
- `BuilderPage.tsx` lines 81–146: `ModelSelect` renders a native `<select>` with `<optgroup>` labels.
- `server/builder/discovery.ts` lines 91–99: `BuilderModelEntry` only exposes `name`, `provider`, `capability`, `available`, `latency`, `qualityStatus`, `label`.

### Fix
1. **Extend `BuilderModelEntry`** to include: `isFree`, `isPaid`, `contextWindow`, `rating`, `supportsImage`, `supportsVideo`, `supportsText`.
2. **Populate new fields** in `getBuilderModelsInventory` using `getModelsDetail()` (free/paid/context) and heuristic name matching for image/video support.
3. **Replace `ModelSelect`** with a custom rich dropdown that:
   - Shows a styled trigger with the selected model name + inline pills (free/paid, img, vid, rating/100).
   - Opens a searchable dropdown panel grouped by capability (heavy/medium/light/OpenCode/Zen/Alibaba).
   - Each row displays: model name, pricing pill, modality pills (img/vid/txt), context-window, latency, quality-status pill, and rating/100.
   - Supports keyboard navigation (Escape to close) and click-outside-to-dismiss.
4. **Add supporting CSS** `.builder-model-select-*` classes to `globals.css` that match the existing navy-amber design system.

### Files
- `server/builder/discovery.ts`
- `app/routes/BuilderPage.tsx`
- `app/globals.css`

---

## 10. Skills Unification & Agent Parity

### Problem
Skills, commands, and MCP servers are segmented by agent. The `SKILL_SOURCES` array in `server/api/agents.ts` assigns each skill directory to a subset of agents (e.g., `codex-user-skills` → only Codex). The `SkillsBrowser` in `AgentDiscoveryStrip.tsx` filters skills by agent, so an agent that shows “30 skills” may actually see zero when the browser opens because the summary endpoint did not return the skills array.

### Evidence
- `server/api/agents.ts` lines 96–110: `SKILL_SOURCES` uses agent-specific arrays.
- `server/api/agents.ts` lines 795–838: `agentsSummaryHandler` returns `counts` but omits `skills` and `commands` arrays.
- `app/components/AgentDiscoveryStrip.tsx` lines 73–82: `SkillsBrowser` filters by `agent`, expecting `data.skills` to exist.

### Fix
1. **Unify skill access**: Change every `agents` array in `SKILL_SOURCES` and `COMMAND_SOURCES` to `ALL_AGENTS` (`["claude","codex","opencode","gemini"]`).
2. **Return skills in summary**: Add `skills` and `commands` arrays to the `agentsSummaryHandler` JSON response so the browser has data to render.
3. **Normalize agent defaults**: Update `normalizeAgents` to fall back to `ALL_AGENTS`.
4. **UI parity**: All agent pages now browse the same skill/command catalog. The count badge and search work identically across Claude, Codex, OpenCode, and Gemini.

### Files
- `server/api/agents.ts`
- `app/components/AgentDiscoveryStrip.tsx` (types already match)

---

## 11. Gemini Image & Video Generation Routing

### Problem
Gemini supports `imagen` (image) and `Veo` (video) generation, but the dashboard has no first-class skills or quick prompts to surface these capabilities. Operators must manually type requests.

### Fix
1. **Add quick prompts** to `/opt/opencode-control-surface/config/agent-quick-prompts.json`:
   - `gemini-image-gen` (name: `imagen`) — routes to Gemini's image generation.
   - `gemini-video-gen` (name: `video`) — routes to Gemini's video generation.
2. **Capability detection** in `BuilderModelEntry`: heuristically mark Gemini models as `supportsImage` and `supportsVideo`.
3. **Model picker visibility**: When a Gemini model is selected in the Builder workflow modal, the img/vid pills are visible, signalling media generation support.

### Files
- `config/agent-quick-prompts.json`
- `server/builder/discovery.ts`

---

## 12. Dynamic Defaults & Button Controls (Workflow Modal)

### Problem
The workflow modal mixes native checkboxes and `<select>` elements. Some features (e.g., effort level) are not supported by all models/backends, but the UI should still show them with sensible defaults. The approval mode is labelled “Gemini approval mode” even though the concept applies to all agents.

### Fix
1. **Generic approval mode**: Rename UI label to “Approval mode”. Keep `geminiApprovalMode` in the stored config for backward compatibility, but treat it as the agent-approval default.
2. **Effort level picker**: Add `effortLevel` (`low` | `medium` | `high`) to `BuilderWorkflowConfig` with a default of `medium`. Store it in the config and parse it in `parseWorkflowInput`.
3. **Button groups**: Replace `<select>` controls for Mode, Status, Commit, Push, Live deploys, Approval mode, and Effort with a `ButtonGroup` component that renders styled segmented buttons.
4. **Add CSS** `.builder-btn-group-*` for the segmented control look.

### Files
- `server/builder/store.ts`
- `server/api/builder.ts`
- `app/routes/BuilderPage.tsx`
- `app/globals.css`

---

## 13. Implementation Order (Recommended)

| Priority | Task | Files |
|----------|------|-------|
| P0 | Fix mobile topnav congestion (hamburger + second row) | `DashSidebar.tsx`, `globals.css` |
| P0 | Unify agent page controls (runtime bar + transcript controls) | `GeminiPage.tsx`, `ClaudePage.tsx`, `CodexPage.tsx`, `OpenCodeView.tsx`, new components |
| P1 | Fix table overflow on mobile (column hiding + button stacking) | `AutopipelinePage.tsx`, `ModelsPage.tsx`, `BuilderPage.tsx`, `globals.css` |
| P1 | Fix collapsible section border visuals | `SectionCard.tsx`, `BuilderPage.tsx`, `globals.css` |
| P1 | Tighten bootstrap/workflow spacing on Builder page | `BuilderPage.tsx` |
| P2 | Fix modal/dialog spill on mobile | `globals.css`, `BuilderPage.tsx` |
| P2 | Remove dead nav links or add missing routes | `DashSidebar.tsx`, `App.tsx` |
| P3 | General CSS hygiene (z-index, padding) | `globals.css` |

---

## 10. Verification Checklist

After implementing, verify with Playwright across:
- **Desktop:** 1920×1080
- **Tablet:** 820×1180
- **Mobile:** 393×852 (iPhone 16 Pro)

For each viewport, check:
- [ ] Topnav fits without horizontal scrolling; all links reachable.
- [ ] No table extends beyond viewport width; horizontal scroll only inside `.table-wrap`.
- [ ] Collapsing any `SectionCard` does not leave an awkward empty bordered box.
- [ ] All modals fit within viewport; no inner content overflows.
- [ ] Agent pages (`/gemini`, `/claude`, `/codex`, `/opencode`) show identical control sets (model, approval, transcript filter).
- [ ] Builder page: bootstrap and workflow actions are visually adjacent.
- [ ] No 404-like dead links in the nav drawer.
- [ ] Bottom tab bar does not overlap page content on any non-chat page.

---

*Plan generated by OpenCode audit session on 2026-05-13.*


---
## Builder Run br_1eba0
- **Status**: failed
- **Trigger**: manual
- **Finished**: 2026-05-13T21:55:33.919Z
- **Artifact**: /var/lib/control-surface/builder-runs/br_1eba0a6c-97ff-4cbd-b838-9bd13c08f2d5/


---
## Builder Run br_f9604
- **Status**: failed
- **Trigger**: retry
- **Finished**: 2026-05-13T22:09:41.252Z
- **Artifact**: /var/lib/control-surface/builder-runs/br_f96040fd-e3dd-4bcb-bd4d-6e785d483098/


---
## Builder Run br_2aa0a
- **Status**: failed
- **Trigger**: retry
- **Finished**: 2026-05-14T11:43:01.051Z
- **Artifact**: /var/lib/control-surface/builder-runs/br_2aa0a844-8862-41ee-ac9b-765edd38b32a/
