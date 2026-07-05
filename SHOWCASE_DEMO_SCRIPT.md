# Control Surface — Golden Demo Script (ULTRAPLAN P1.3)

**Created**: 2026-07-04 · **Companion to**: `SHOWCASE_SPINE_PLAN.md`, `e2e/demo/REHEARSAL_REPORT.md`
**Rehearsed**: twice, end-to-end, against a fresh `oven/bun:1` container booted the same way a customer would (see Setup below). Both runs' findings are in `e2e/demo/REHEARSAL_REPORT.md`.
**Runtime**: ~6-8 minutes at a comfortable pace.

This is the literal click-by-click script for the golden flow:
**install → login → first-run wizard → switch to demo tenant → insights inbox opener → an insight with evidence drawer → apply → audit row shown → cost page savings story.**

Every step below says three things: what you click, what you must see, and what proves it's real (an id, a hash, a live API response — not a screenshot). Steps that use the seeded **Northstar Showcase Demo** tenant are marked **[DEMO DATA]** — clearly-labeled, staged, seeded data (per G3). Steps that exercise real, live mechanism (auth, RBAC, the apply pipeline, the audit hash chain, the gateway router) are marked **[LIVE MECHANISM]** even when the input happens to be demo data — the code path executing is the same one that runs in production.

---

## Setup (once, before presenting)

1. Boot the container: `e2e/demo/record-cold-install.sh` (or reuse the one already running from that recording — do not run `install.sh` twice against the same container).
2. Note the operator token: `cat /tmp/cs-demorec-work/src/control-surface.env` → `OPERATOR_TOKEN=...`.
3. Open `http://localhost:4620/` in a real browser window (1280×720 or larger). Do not pre-authenticate with a cookie — the whole point of step 2 below is the real login screen.

---

## Step 1 — Install (already done in Setup; narrate, don't re-run)

If presenting live end-to-end (not just the recorded clip), this is where `cold-install.cast` plays: `./install.sh` prints its prerequisite checks (bun/git/curl), runs `bun install` + `bun run build`, prints the operator token **once**, and starts the server in the foreground. Cold install to a healthy `/health` 200 takes well under a minute inside a fresh `oven/bun:1` container (verified: ~13s of actual install+build+boot work, plus container/image overhead).

**Proof it's real**: the token printed is freshly generated per install (`crypto.getRandomValues`, 32 bytes hex) and written once to `control-surface.env` (chmod 600) — it is never re-printed on a re-run, matching the comment in `install.sh` line 174.

## Step 2 — Login (real screen, real 401, real cookie)

1. Load `http://localhost:4620/`. The page attempts its first API calls (e.g. `GET /api/home`) with no session cookie yet, gets a real `401`, and the app's own auth flow fires — a modal titled **"Authentication Required"** appears automatically (not a separate `/login` route — see `app/lib/authFetch.ts`, which dispatches the `auth-required` DOM event on any 401).
2. Type the operator token from Setup step 2 into the **Operator token** field.
3. Click **Authenticate**.
4. **You must see**: the modal closes, the dashboard renders (Operations / Home page, sidebar populated).

**Proof it's real** — **[LIVE MECHANISM]**: `POST /api/auth/session` returns `{"ok":true}` and sets an `HttpOnly`, `SameSite=Strict` `operator_session` cookie (`server/api/auth.ts` via `server/auth/session.ts`). This is the same cookie every other route in the app checks; there is no demo-only auth bypass.

## Step 3 — First-run wizard

1. On Home, a banner reading **"Welcome — name this installation to finish setup."** is visible above the dashboard widgets (`FirstRunSetupBanner`, `app/routes/DashHome.tsx`).
2. Type an install name, e.g. `Northstar Robotics`, into the text field.
3. Click **Finish setup**.
4. **You must see**: the banner disappears immediately; it does not come back on refresh.

**Proof it's real** — **[LIVE MECHANISM]**: `GET /api/setup/state` returns `{"needsSetup": true}` before this step (because a fresh DB writes a `setup.pending` marker at birth — `server/db/dashboard.ts`) and `false` after. `POST /api/setup/complete` renames the seed tenant (`tenants` row for `mimule`) to whatever you typed and writes a `setup.completed` marker + an `action_audit` row (`actionKind: "setup.complete"`). This is the exact mechanism that gates a real fresh host from re-showing the wizard forever, and a pre-existing host (this VPS's own tenant, still literally named `MIMULE`) from ever seeing it (see the long comment at the top of `server/api/setup.ts`).

## Step 4 — Switch to the demo tenant

1. In the top header, click the **tenant** pill (currently shows `MIMULE` or whatever you just named it).
2. A dropdown opens with two entries: your renamed tenant, and **Northstar Showcase Demo**.
3. Click **Northstar Showcase Demo**.
4. **You must see**: the pill now reads `tenant: Northstar Showcase Demo`. Every page you visit from here on is scoped to that tenant via the `x-tenant-id` header (`app/lib/authFetch.ts`) — this is real multi-tenant isolation, not a client-side filter.

**Labeling** — **[DEMO DATA]** from here: everything under this tenant was written by `server/db/demo-seed.ts` (gated on `DEMO_SEED=1`, which only this recording/demo container ever sets — never the live service). Say so out loud: *"I'm switching into a demo tenant we seed for showcases — the mechanism you're about to see is identical to what runs for a real tenant."*

## Step 5 — Insights inbox opener

1. Click **Detections** in the sidebar (routes to `/insights` — the Insights Inbox / Admin Center "Detections & Auto-fix" page).
2. Click **Scan now** (top right of the hero section).
3. **You must see**: the inbox populates. Click the **Cost** domain filter chip to narrow to exactly two findings, both titled **"Spend is running above its normal range"** — one high severity (workflow `demo-wf-agent-team`, 3.7× baseline, "Expected $4.20, observed $15.38"), one medium (project `insights-inbox`, 2.9× baseline).

**Why "Scan now" and not just arriving**: the inbox's background aggregation is throttled to once per 60 seconds process-wide (`server/api/insights.ts`, `LIST_AGGREGATE_THROTTLE_MS`) so it doesn't re-scan the whole platform on every page view. If the operator's Home page already consumed that window under a different tenant moments earlier, a bare page load can show an empty inbox for the newly-selected tenant. Clicking **Scan now** always runs a full, synchronous scan (`POST /api/insights/scan`) regardless of the throttle — it is the honest, real control already in the UI for exactly this situation, not a workaround.

**Proof it's real** — **[LIVE MECHANISM]** operating on **[DEMO DATA]**: these two findings are generated live, on your click, by `aggregateSpendAnomalies()` (`server/insights/aggregate.ts`) reading the tenant's `spend_anomalies` rows — the same scanner that runs against real tenants every 15 minutes in production.

## Step 6 — Open an insight, expand the evidence drawer

1. On the high-severity card, click **Evidence** to expand the drawer.
2. **You must see** two evidence rows:
   - `db` · Spend anomaly · **redacted** — evidence kind `"db"` is always shown as `redacted` in the UI (raw row references are never printed to the screen — see `EvidenceDrawer` in `app/routes/InsightsPage.tsx`), even though the server holds the real reference (`spend_anomalies:demo-anomaly-paid-fallback`).
   - `api` · Cost attribution · `/api/cost/attribution/workflow?entityId=demo-wf-agent-team` — a real, callable API path (not redacted, because it's just a route, not raw data).
3. Optionally open a second browser tab to that exact URL (with the same session cookie / tenant header) to show it return real JSON: 3 cost events (`demo-cost-001/004/006`), `total_usd: 0.1538` — the same $15.38 the anomaly card cites. (This link 400'd with "Unsupported entity type" before this rehearsal — see the Known limitations section; it now resolves correctly.)

**Proof it's real** — **[LIVE MECHANISM]**: the evidence reference is generated by the same code that would generate it for a real tenant's real spend anomaly; the redaction rule is a blanket UI policy, not something toggled for the demo.

## Step 7 — Apply

1. In the **Reason** field on that same card, type a short reason, e.g. `Demo walkthrough: cap paid fallback and confirm free-first routing stays healthy.`
   - **This is required, not optional.** This action's enforcement is `reasonRequired: true` (medium risk, `start-job:gateway:route-healthiest`) — leaving it blank and clicking Apply returns *"Please add a short reason before applying this insight."* as an inline message, not a silent failure. Worth showing once, briefly, as proof the platform enforces its own policy rather than rubber-stamping every click.
2. Click **Apply**.
3. **You must see**: a confirmation message — *"The insight was applied and recorded in the audit trail."* — and the card's status pill changes to **Applied**.

**What actually happened** — **[LIVE MECHANISM]**: this is not a canned response. The click ran the real `start-job:gateway:route-healthiest` action (`server/api/execute.ts`), which picked the healthiest available model and wrote a live route override, visible afterward on `/gateway` (`routeOverride.reason` on that page shows your typed sentence verbatim). Because the insight's risk is `medium` (not `high`/`destructive`), it applied immediately — no approval gate. **If you re-run this against a `high`-risk insight** (e.g. anything under `mutate-policy` besides model/autoapply, or any `start-job` against `service`/`vast`), Apply instead opens an approval request and reports *"This action is high risk, so an approval request was opened before applying it."* — that's the approval-gated path referenced in the golden flow's step name; none of the two demo cost insights are high-risk, so this rehearsal exercises the direct-apply branch. Say this out loud rather than staging a fake high-risk click.

## Step 8 — Audit row shown

1. Click **Audit** in the sidebar (`/audit`).
2. The page opens on the **System Events** tab by default — click the **Operator Actions** tab.
3. **You must see**, at the top of the table: a row with action `insights.apply`, target `insight_cost_anomaly_demo-anomaly-paid-fallback`, result `success`, risk `medium`, actor `operator-bootstrap` (the built-in bootstrap identity behind the raw operator token — see `SHOWCASE_SPINE_PLAN.md` Phase 1 for the real-user RBAC layer this sits on top of). Click **details** to open the drawer and show the reason you typed, the rollback hint (`start-job:gateway:clear-route-override`), and the full request/result JSON.
4. Point at the green **✓ Chain OK** badge above the table (`ChainStatusBadge`, reading `GET /api/audit/chain-status`).

**Honest caveat — say this explicitly**: the chain badge verifies a SHA-256 hash chain (`prev_hash`/`row_hash`) over the **5 pre-seeded demo audit rows** (`server/db/demo-seed.ts`) — that's what "5 rows verified, head: <hash>" means. The row you just created by clicking Apply (and the platform's own `insights.scan` / `incidents.auto-resolve` rows from earlier) are written by the live `writeActionAudit()` path and **do not currently extend that hash chain** (`appendAudit()` in `server/db/audit/chain.ts` is exposed but not yet wired into the live write path — this is a real, structural gap, not a demo-only one; see Known limitations). Show the new row as proof of live audit logging (who/what/when/why, real actor, real reason, real rollback hint) — don't claim it extends the cryptographic chain.

## Step 9 — Cost page savings story

1. Click **Cost** in the sidebar (`/cost`).
2. **You will see** the "This Month at a Glance" band show `$0.00` for Spend (MTD) and Saved by Free-First, each with an honest caption: *"needs gateway ledger data"*. The Cost Anomalies and Budgets sections below will also say *"No cost anomalies detected in the last 30 days"* / *"No budgets defined"*.
3. **Say this explicitly, don't skip past it**: this page's headline widgets read from the live gateway-call ledger (`gateway_calls`) and system `events` table — real, tenant-agnostic operational telemetry that this demo container has never generated (no actual model calls were routed through the local gateway). The platform does not fabricate a number here; it says plainly that it doesn't have one yet. That itself is the point: *"When there's no data, it tells you — it never makes one up."*
4. Pivot to the real, tenant-scoped savings proof you already built in Steps 5-7: click **Gateway** in the sidebar. Near the top, an amber pill reads **"routing via opencode/nemotron-3-ultra-free"**, followed by your typed reason in quotes: *"Demo walkthrough: cap paid fallback and confirm free-first routing stays healthy."* Hovering the pill also shows the expiry timestamp.

**Proof it's real** — **[LIVE MECHANISM]**: `GET /api/gateway/status` returns `routeOverride` with your typed reason and a real expiry timestamp, plus `costHeadline.headline: "Cost tracking is warming up — no gateway calls recorded in the last 30 days."` — the same honest-empty-state sentence as the Cost page, worded for a technical audience.

---

## Known limitations (report honestly if asked; do not paper over)

- **Cost page headline / anomalies / budgets are not wired to the demo tenant's seeded data.** `computeCostHeadline()`, `getSpend()`, `getFallbacks()`, and `readRecentCostAnomalies()` (`server/api/cost.ts`) all read from `gateway_calls` and `events`, which `demo-seed.ts` never populates (it seeds `cost_events`/`spend_anomalies` instead, which power the Insights Inbox and `/api/cost/attribution/*` correctly). Fixing this is a real architectural reconciliation (unify the two cost data models, or teach the Cost page to also read `cost_events`), not a one-line fix — reported here, not built, per this task's scope.
- **`demo-seed.ts`'s clock is a fixed calendar date** (`DEMO_NOW = Date.UTC(2026, 5, 10, ...)`, i.e. 2026-06-10), not relative to real time. As real time moves further past that date, seeded timestamps silently age out of any "last 30 days" / "this month" window elsewhere in the app (this is *why* the Cost page issue above is masked rather than merely "not yet populated" — even fixing the table mismatch wouldn't survive time passing without also making this seed clock relative to boot time). Two reasoner incidents (`demo-ri-cost`, `demo-ri-queue`) auto-resolve as "stale" within one scan the further this demo drifts from 2026-06-10 — expected, not a bug, but re-seed or bump the date before a demo scheduled long after this was written.
- **Approval-gated Apply is not exercised by the two seeded cost insights** — both resolve to `medium` risk, so Step 7 always takes the direct-apply branch. If a live audience specifically asks to see the approval queue, that requires a `high`-risk action, which this seed doesn't include a ready-to-click example of.

## Fixed during rehearsal (see `e2e/demo/REHEARSAL_REPORT.md` for full detail)

- **Tenant/project switcher dropdown was visually present but only its top ~10% was clickable** — a CSS stacking-context bug (`app/globals.css`, `.dash-header`) trapped the dropdown below the page content for hit-testing. Fixed.
- **The "Cost attribution" evidence link on every spend-anomaly cost insight 400'd** ("Unsupported entity type") — `getAttribution()` (`server/api/cost.ts`) didn't handle the `workflow`/`project` entity types that `aggregateSpendAnomalies()` (`server/insights/aggregate.ts`) actually generates. Fixed; this was a live bug affecting real spend-anomaly insights too, not a demo-only issue.
- **The Gateway page's route-override reason was hover-only** — `GatewayPage.tsx` put the operator's typed Apply reason only in a `title` tooltip attribute (invisible until hovered, easy to miss while narrating live). Now shown as visible text next to the routing pill too. Fixed.
