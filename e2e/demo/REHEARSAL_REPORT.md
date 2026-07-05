# SPEC 6 — Rehearsal Report (ULTRAPLAN P1.3 + P1.4)

**Date**: 2026-07-04 · **Container**: `cs-demorec` (`oven/bun:1`, `--memory 2g --cpus 2`, host port 4620, `DEMO_SEED=1`), booted from a working-tree archive of `/opt/opencode-control-surface` (same idiom as `e2e/fresh-host/run.sh`).

This report covers rehearsing `SHOWCASE_DEMO_SCRIPT.md`'s golden flow (steps 1-9: install → login → first-run wizard → switch to demo tenant → insights inbox opener → an insight with evidence drawer → apply → audit row shown → cost page savings story) twice, end-to-end, against the kept container, plus the clip inventory.

Rehearsal was driven by a scratch Playwright script (`e2e/demo/_rehearse.mjs` while in use; deleted before hand-off — not a committed deliverable) that clicks through steps 1-9 in the exact order the script specifies and asserts on the same things a human presenter would look for (banner text, dropdown contents, card counts, evidence text, audit rows, honest empty-state captions).

## Stumbles found while building and first rehearsing the script

Three real defects surfaced while actually driving the flow (not just reading the code). All three were surgically fixable and are now fixed. None required a database/schema change or touched the seed's row counts.

### 1. Tenant/project switcher dropdown was only clickable on its top ~10%

**Where**: Step 4 ("switch to demo tenant"). Clicking the tenant pill correctly opened the dropdown (visible in a screenshot, text readable), but clicking the "Northstar Showcase Demo" item timed out — Playwright's actionability check reported the target as "visible, enabled and stable" yet `<div class="dash-page home-customizable">…</div> intercepts pointer events` on every retry.

**Root cause** (confirmed via `document.elementFromPoint` probing across the item's bounding box — only the top ~10% of the item resolved to the button; the rest resolved to the page content behind it): `.dash-header` (`app/globals.css:738`) has `backdrop-filter: blur(8px)` with `position: static`. `backdrop-filter` creates a new stacking context, but because the header itself is not positioned, that stacking context still paints in plain DOM order relative to its sibling `.dash-page` — which comes right after `.dash-header` in the DOM and was therefore painting *over* the header's entire stacking context, including the `.ctx-dropdown` menu (`z-index: 60`) nested inside it. A `z-index` inside a stacking context can never lift its content above a later sibling of that whole context.

**Fix**: `app/globals.css:738-762` (`.dash-header`) — added `position: relative; z-index: 10;` so the header's own stacking context is explicitly ordered above `.dash-page`, without changing its layout (it was already effectively fixed at the top via flexbox, and its one absolutely-positioned descendant, `.ctx-dropdown`, already had its own nearer positioned ancestor `.ctx-pill-wrap`, so this doesn't change any containing-block behavior — verified no other layout regressions via `bun run check` + full `bun test` + `gate.sh`).

**Real-world impact**: this affected both the tenant pill and the project pill (same `.ctx-dropdown` component), and would have blocked real operators trying to switch tenants with a mouse in production too — not a demo-only defect.

### 2. The "Cost attribution" evidence link 400'd for every spend-anomaly cost insight

**Where**: Step 6 (evidence drawer). The evidence drawer correctly showed a live `api`-kind reference, `/api/cost/attribution/workflow?entityId=demo-wf-agent-team` (and `/api/cost/attribution/project?entityId=insights-inbox` for the other finding). Calling either returned:
```
$ curl .../api/cost/attribution/workflow?entityId=demo-wf-agent-team
{"error":"Unsupported entity type"}   HTTP 400
```

**Root cause**: `aggregateSpendAnomalies()` (`server/insights/aggregate.ts:111`) always builds this evidence link from `spend_anomalies.scope_type`, which is only ever `"workflow"` or `"project"` (`server/insights/scanners/anomaly.ts`, `server/db/demo-seed.ts`). `getAttribution()` (`server/api/cost.ts`, switch at what were lines 393-411) only handled `"article" | "dossier" | "builder-run"` — every spend-anomaly cost insight's evidence link was broken, in production too, not just this demo.

**Fix**: `server/api/cost.ts:406-413` — added `case "workflow": query += "workflow_id = ?"` and `case "project": query += "project = ?"` (both columns already exist on `cost_events`). Verified: `curl .../api/cost/attribution/workflow?entityId=demo-wf-agent-team` now returns `200` with 3 real `cost_events` rows, `total_usd: 0.1538`.

**Tests added**: `server/api/cost.test.ts` — new `describe("getAttribution")` block (4 cases: workflow, project, the pre-existing article/dossier/builder-run types still work, and a genuinely-unsupported type still 400s). `bun test server/api/cost.test.ts` → 11 pass / 0 fail (was 7 pass before this change; getAttribution had zero prior test coverage).

### 3. The Gateway route-override reason was hover-only

**Where**: Step 9 (cost page savings story → pivot to `/gateway`). `GET /api/gateway/status` correctly returned the operator's typed Apply reason in `routeOverride.reason`, but `GatewayPage.tsx` (line ~403, the "routing via …" pill) only put it in a `title` tooltip attribute — invisible in a screenshot/recording and easy for a presenter to forget to hover over live.

**Fix**: `app/routes/GatewayPage.tsx:402-419` — the reason is now also rendered as visible text (`"…the exact sentence…"`) next to the pill, and folded into the tooltip too. `SHOWCASE_DEMO_SCRIPT.md` step 9 was updated to describe the now-visible text instead of a tooltip-only claim.

## Rehearsal Run 1 (2026-07-04 18:55 UTC) — first full pass of the finalized script, fresh container

Fresh `cs-demorec` boot (all three fixes above already applied), full Playwright walk of steps 1-9 in the script's order:

```
--- Step 1: Login ---
  [PASS] auth modal appeared automatically on first 401
  [PASS] modal closed after Authenticate
--- Step 2: First-run wizard ---
  [PASS] first-run banner visible
  [PASS] banner gone after Finish setup
--- Step 3: Switch to demo tenant ---
  [PASS] dropdown lists Northstar Showcase Demo
  [PASS] tenant pill now reads Northstar Showcase Demo
--- Step 4: Insights inbox opener ---
  [PASS] exactly 2 cost findings after Scan now + Cost filter
  [PASS] first card is "Spend is running above its normal range"
--- Step 5: Evidence drawer ---
  [PASS] evidence shows redacted db ref
  [PASS] evidence shows live api ref path
--- Step 6: Apply ---
  [PASS] apply success message shown
--- Step 7: Audit row shown ---
  [PASS] chain badge present ("✓ Chain OK")
  [PASS] first audit row is our insights.apply action
--- Step 8: Cost page savings story ---
  [PASS] cost page shows honest empty-state caption (not a fabricated number)
--- Step 9: Gateway route override (pivot proof) ---
  [PASS] gateway page shows our typed reason from Apply

uncaught page errors: none
REHEARSAL: CLEAN
```

(This run's "Step 9" is where stumble #3 was actually caught, on the attempt immediately before this one against the same fix-in-progress codebase; the transcript above is the confirming pass right after applying the `GatewayPage.tsx` fix.)

## Rehearsal Run 2 (2026-07-04 18:56 UTC) — independent fresh-container repeat

Container torn down and rebuilt from scratch (fresh archive, fresh DB, fresh operator token), same script driven the same way:

```
--- Step 1: Login ---                              [PASS] [PASS]
--- Step 2: First-run wizard ---                    [PASS] [PASS]
--- Step 3: Switch to demo tenant ---                [PASS] [PASS]
--- Step 4: Insights inbox opener ---                [PASS] [PASS]
--- Step 5: Evidence drawer ---                      [PASS] [PASS]
--- Step 6: Apply ---                                [PASS]
--- Step 7: Audit row shown ---                      [PASS] [PASS]
--- Step 8: Cost page savings story ---              [PASS]
--- Step 9: Gateway route override (pivot proof) ---  [PASS]

uncaught page errors: none
REHEARSAL: CLEAN
```

Identical, fully clean result on a completely independent container — confirms the flow is repeatable, not a fluke of leftover state.

**Additional spot-check**: after producing the real clips (below), the clip-producing `cs-demorec` container itself was independently re-driven through steps 3-9 (steps 1-2 were already exercised live by `record-wizard.mjs`'s own recording) and passed cleanly too — the only "failure" was the (expected, correct) idempotent skip of re-typing the install name, since setup was already completed moments earlier by the wizard recording on that same container.

## Clip inventory

| File | Size | Duration | Notes |
|---|---|---|---|
| `e2e/demo/clips/cold-install.cast` | 4.6 KB | 10.5 s | asciinema v2 cast, 100×32 cols/rows. Prereq checks (`bun=yes git=no curl=no`) → `bun install` (255 packages, 1.79s) → `bun run build` (vite, 5.6s) → operator token printed once → server listening on :3000 → live `curl -s -o /dev/null -w 'HTTP %{http_code}' /` → `HTTP 200`. Wall-clock UTC timestamps visible at start (`2026-07-04T18:59:04Z`) and end (`2026-07-04T18:59:15Z`). |
| `e2e/demo/clips/first-run-wizard.webm` | 1.1 MB | ~20 s (measured via wall-clock script timing from page-creation to context-close; `ffprobe`/`mediainfo` are not installed on this host to read the container's own duration atom) | 1280×720 WebM. Real login (token from the container's own `control-surface.env`, no cookie injection) → first-run banner → "Northstar Robotics" typed → Finish setup → banner gone → tenant switch to Northstar Showcase Demo → Insights inbox (Scan now → Cost filter → Evidence drawer expanded) → `/today` → `/cost`. |

Both clips are gitignored (`e2e/demo/clips/`) and were never committed.

## Verification

- `bun run check` — clean (typecheck + vite build, 0 errors) after all three fixes.
- `DASHBOARD_DB=1 bun test` — 946 pass / 0 fail (942 baseline + 4 new `getAttribution` tests). See tail below.
- `bash e2e/fresh-host/gate.sh` — run because `app/globals.css`, `app/routes/GatewayPage.tsx`, `server/api/cost.ts`, and `server/api/cost.test.ts` all changed. See tail below.

(Full tails pasted into the builder's final report to the orchestrator.)
