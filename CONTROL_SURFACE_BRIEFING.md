# Control Surface — Session Briefing (context + objectives)

**You are a fresh Claude session (Fable 5) taking over work on the TIB Control Surface.** Read this first, then `/root/CLAUDE.md` for stack-wide rules. Owner: Marouane.

---

## 1. What the Control Surface IS

`/opt/opencode-control-surface` — an operator control plane for an AI-operated software/media company, live at **control.techinsiderbytes.com** (systemd `control-surface.service`, port 3000). Stack: **Bun + TypeScript + React 19 + Vite + Tailwind v4 (OKLCH tokens) + SQLite (`bun:sqlite`)**. Single `bun run server/index.ts` serves both the API and the SPA from `dist/`.

**The product vision:** a sellable, pick-your-modules bundle — *"the Microsoft 365 admin centers, but AI-led."* Modules: **Cost Firewall** (gateway), **Software Factory** (builder/studio), **Control Tower** (governance/admin centers), **Autonomous Ops** (reasoner/doctor/agent-team), **Content Engine** (newsbites). The investor wedge: a **governed AI workforce you own** — it builds, ships, and operates software, and every action is cheap, traced, and reversible.

## 2. Current state (as of 2026-06-11) — the showcase spine is COMPLETE

All built, deployed, verified:
- **Phase 1 — Identity + RBAC** ✅ real users, local login (`/api/auth/login`), role-gating. Invite via `/api/settings/access`. (Validated: a non-owner user logs in and is correctly gated to view-only.)
- **Phase 2 — Insights Inbox** ✅ the demo centerpiece (`/insights`). AI recommendations grouped by cost/security/build/data with one-click apply + audit. Fed live by the sentinel (see below).
- **Phase 3 — Self-correction proof** ✅ on `/agent-team`: "every change is audited & reversible" — 15 builds audited / 9 shipped / 6 safely rolled back. The investor trust centerpiece.
- **Phase 4 — Plain-English UX** ✅ on the 6 demo routes (`/`, `/insights`, `/gateway`, `/agent-team`, `/builder`, `/governance`): no raw JSON/stack traces.
- **Phase 5 — Showcase metrics** ✅ `GET /api/metrics/showcase` returns real numbers for the slide.
- **Product Health Sentinel** ✅ `/usr/local/bin/mimule-product-sentinel.py` (timer, every 30 min): probes the LIVE site (pages, APIs, data freshness, deploy consistency, invariants), writes `/var/lib/mimule/product-health.json`, surfaces a DashHome tile + flows findings into the Insights Inbox. **Currently 100/100, 0 fails.**

## 3. CRITICAL operating rules (learned the hard way — do not relearn)

- **The autonomous team is PAUSED on purpose.** `mimule-jobd` is stopped because its Playwright/Chromium-heavy validation + leaked ephemeral bun servers **wedge the live demo site** (happened 5× one night). Do NOT resume `mimule-jobd` unless builds are moved off-box. The 3 sprawl enqueuers (`mimule-orchestrator.timer`, `mimule-project-improve.timer`, `mimule-overseer.timer`) must STAY OFF.
- **A rogue duplicate service `opencode-control-surface.service` (vite preview) was the wedge engine — it is disabled. Keep it dead.** If the site wedges, check for stray `bun run preview`/`server/index.ts` orphans on :3000.
- **Build like this (clean single builds — never wedged):** edit → `bun run typecheck` → `bun run build` → ephemeral boot check (`PORT=34xx DASHBOARD_DB=1 bun run server/index.ts &`, curl, kill) → `systemctl restart control-surface.service` → verify site fast + `/api/version`. Do NOT run Playwright on this box.
- **Never touch `/opt/newsbites`** (live). **Studio (`/opt/studio-platform`) stays held** (separate product, on :3300 — legit, leave it).
- After meaningful work, append to `/opt/ai-vault/daily/2026-06-11.md`.

## 4. Objectives (remaining backlog, in priority order)

**Strategic decision pending (Marouane's, infra-spend):** move the autonomous team's builds OFF this box (separate VPS or the GPU box) so the team can resume without wedging the demo. Until then, hand-build (clean single builds work great).

**Tier 2 — harden the centerpiece (trustworthy autonomy = the product):**
- Insights Inbox apply-path: make ≥3 one-click fixes work end-to-end with attributed, reversible audit (`server/insights/`, `server/api/actionDescriptors.ts`, `action_audit`).
- Sentinel v2: agent-runner round-trip probes (codex/opencode/gemini liveness) — quota-aware.

**Tier 3 — product quality:**
- **Cost Firewall**: a CFO-legible "free-first routing keeps LLM cost near zero" headline on `/gateway` (note: `cost_events` is empty — use the model-health free/available split, not invented €).
- **Security posture surface (Defender-lite)**: build a UI on top of the sentinel's existing `server/insights/scanners/security.ts` — the first real M365-style admin center.
- The Gateway page is a product question: it shows LiteLLM *routing* models (5) vs the full *discovery* roster (135 in `model-health.json`). Decide what it should show.

**Demo polish:** rehearse the golden flow; consider a "showcase numbers" tile on DashHome wired to `/api/metrics/showcase`.

## 5. Key paths
- App: `/opt/opencode-control-surface/{app,server,dist}` · DB: `/var/lib/control-surface/dashboard.sqlite`
- Sentinel: `/usr/local/bin/mimule-product-sentinel.py` → `/var/lib/mimule/product-health.json`
- Vault log: `/opt/ai-vault/daily/YYYY-MM-DD.md` · This session's record: `/opt/ai-vault/daily/2026-06-10.md`
- Showcase spine plan: `/opt/opencode-control-surface/SHOWCASE_SPINE_PLAN.md`
- Operator token: `systemctl show control-surface.service -p Environment --value | tr ' ' '\n' | grep OPERATOR_TOKEN`

**Verify the live product before claiming anything done.** The platform is in strong, demoable shape — keep it that way.
