# Control Surface — Investor Showcase Spine Plan

**Created**: 2026-06-10 · **Owner**: Marouane Defili · **Advisor**: Claude (Opus)
**Deadline**: investor showcase in the weeks following 2026-06-10 (target ~3 weeks)
**Repo**: `/opt/opencode-control-surface` · **Live**: control.techinsiderbytes.com

---

## 0. Thesis (read first)

Sell the platform as a **pick-your-modules bundle** (Cost Firewall · Control Tower · Autonomous Ops · Content Engine). The licensing/feature-gate machinery already supports per-module sale.

**Studio (planner + builder idea→app) is carved out as a SEPARATE product, reserved until mature** (decided 2026-06-10) — the idea→app space is polish-sensitive (Lovable/Bolt/v0/Replit) and deserves its own clean surface. It is NOT in this showcase. BUT the builder's *proof* stays in the demo: show the already-real **Agent Team build → audit → rollback** loop. Defer the consumer wrapper; keep the engine's credibility.

**Showcase frame (decided 2026-06-10): option 1 — showcase the mature slice in weeks, pitch engine + trajectory.** Insights Inbox + cost + the agent-team build/rollback proof; Studio and the full admin centers (Defender/Purview/Priva) shown as funded roadmap, not pre-built.

**Do NOT try to complete five products before the showcase.** Win the room with ONE spine that makes the whole bundle look complete and coherent:

> **The Insights Inbox** — AI analyzes → recommends in plain English → human clicks Apply (or opens the manual page) → every action is traced and reversible.

This is the "M365 admin center but AI-led" promise made real, and it is *truthful*: the engine already exists (`server/reasoner/` + `server/api/actionDescriptors.ts` + `action_audit`). The spine = generalize that engine across 3 domains (cost, security, build) and give it one surface. Everything else in the bundle becomes "the same engine also does this."

### What's already real (keep — do not rebuild)
- **Reasoner**: `reasoner_diagnoses`, `reasoner_incidents`, clustering, playbooks w/ `applyPlaybookAction` + `is_safe`.
- **Apply framework**: `api/actionDescriptors.ts` (rich `ActionDescriptor`: kind/targetType/evidenceRefs/confirm/reasonRequired), `api/actions.ts` handlers, `action_audit` sink.
- **Finding sources**: `spend_anomalies`, `content_health_findings`, `reasoner_diagnoses`.
- **Gateway**: router, cost ledger (`cost_events`, `gateway_calls`), `/api/cost/attribution/`, `provider_price_catalog`.
- **Builder**: durable runner/scheduler/doctor/validation (6.5k LOC — the deepest module).
- **Governance primitives**: policy engine, KEK secrets vault, 4-eyes approvals, budgets, retention.
- **Tenancy**: `tenants`, `tenant_settings`, `tenantScope.ts` (tested).

### The real gaps (build these)
- **Identity is fake**: `governance/rbac.ts:resolveRole()` is token→owner/viewer only. `governance_role_bindings`, `sso_configs`, `sso_sessions` tables exist but aren't wired to a real user. **#1 blocker.**
- **No unified Insights Inbox**: findings live in separate tables with no aggregation/surface.
- **No security/data posture scanners** (Defender/Purview analogues).
- **No plain-English idea→app front door** (Studio wrapper over Builder).
- **Compliance is a doc generator** (`compliance/generator.ts`), not a posture center — out of showcase scope; roadmap.

---

## Hard rules (every pass obeys)

- **Dispatch idiom**: Claude plans (this file) → OpenCode/free models build → Codex verifies/audits. Use the `dashboard-orchestrator` skill for slices. Claude validates + deploys; Claude does not hand-write production code.
- **Validation gate after every pass** (non-negotiable, all must pass):
  - `bun run check` (typecheck + vite build, 0 errors)
  - `DASHBOARD_DB=1 bun test` on touched modules — keep baseline ≥260 pass / 0 fail
  - Ephemeral smoke boot on a scratch port + curl the new endpoints (valid JSON, 200)
  - Playwright multi-viewport (desktop + tablet + iPhone 16 Pro), 0 console/page errors
  - Restart `control-surface.service`, confirm clean journal + live 200s
- **Never touch `/opt/newsbites`** without explicit instruction (live site).
- **Log to AI Vault** after each meaningful pass (`/opt/ai-vault/daily/YYYY-MM-DD.md`) and append a progress entry to `MIMULE_MASTER_PLAN_V3.md`.
- **Plain English everywhere**: no stack traces / raw JSON to the user — every error & insight is a sentence + recommended action + Apply + manual-page link.

---

## Phase 0 — Foundations & credibility (small, do first)

- [x] Replace the `dev` build tells: real `BUILD_HASH` (git short sha) + `buildTime` in `server/version.ts`; ensure prod start sets `NODE_ENV=production` (drop-in env). `GET /api/version` must show a real commit, not `"dev"`. *(done 2026-07-03 — live unit sets NODE_ENV=production; /api/version shows real commit + "production")*
- [x] Add a production build/start path documented in README (no `nodeEnv: development` in the showcase deploy). *(done — README "bun run start" section documents production metadata)*
- [x] Create a **demo-seed script** `server/db/demo-seed.ts`: seeds one clean tenant with believable, *alive* data — populated `cost_events` (free-first savings visible), a hash-linked `action_audit` chain, 2–3 `reasoner_incidents`, 3–5 agent-team jobs, a couple `spend_anomalies`. Idempotent, behind `DEMO_SEED=1`. *(done — exists, gated on DEMO_SEED=1)*
- [x] Validation gate. *(2026-07-03: bun run check clean, 914 tests / 0 fail, live 200s)*

## Phase 1 — Real identity + RBAC (the #1 blocker)

- [x] Add a `users` table (id, email, name, auth_method, created_at) + migration in `server/db/dashboard.ts`. *(done — live DB has users + local_account_credentials)*
- [x] Wire `governance/rbac.ts`: replace token-only `resolveRole()` with lookup of `governance_role_bindings` by authenticated user → role; keep operator-token as bootstrap "owner" fallback for local/dev. *(done — roleFromBinding + operator-bootstrap; 2026-07-03 fix: token valid from any origin in production)*
- [x] Local accounts MVP: `POST /api/auth/login` (email + password hash, argon2/bcrypt) issuing the existing HttpOnly `operator_session` cookie but carrying a real `userId`; keep SSO/OIDC (`sso/oidc.ts`) as the enterprise path (roadmap, stub OK). *(done — Bun.password verify, signed session cookie with userId)*
- [x] **Role management UI**: a `/settings` → Access tab — list users + role bindings, invite, set role (owner/operator/auditor/viewer). Reads/writes `governance_role_bindings`. *(done — SettingsPage Access tab with AccessUser/AccessRole)*
- [x] Stamp every `action_audit` + mutation with the real `userId` (who-did-what is now true, not "operator"). *(done — writer.ts resolves userId from current user)*
- [x] Tests: role resolution from bindings, permission gates per role, audit attribution. Validation gate. *(done — auth+governance suites: 52 pass / 0 fail on 2026-07-03)*

## Phase 2 — The Insights Inbox (the centerpiece)

- [x] **Unified model**: `server/insights/` module — `Insight` type `{ id, domain: "cost"|"security"|"build"|"data", severity, title, plainSummary, confidence, evidenceRefs[], actionDescriptorId|null, manualPageHref, status: "open"|"applied"|"dismissed", tenant_id, createdAt }`. SQLite table `insights` + migration. *(done — full module, live)*
- [x] **Aggregator** `server/insights/aggregate.ts`: pulls from existing sources → normalizes to `Insight`: *(done)*
  - cost ← `spend_anomalies` (+ "swap to cheaper model" recommendation from `provider_price_catalog`)
  - build ← `reasoner_diagnoses` / `reasoner_incidents` (already has suggestedActions + confidence)
  - content ← `content_health_findings`
- [x] **Security scanner** `server/insights/scanners/security.ts` (Defender-lite, real but small): flags exposed/unencrypted secrets, over-broad role bindings (e.g. too many owners), policies in `log-only`, agents running with no budget cap. Emits `Insight`s. Scheduled scan (reuse timer pattern) + on-demand `POST /api/insights/scan`. *(done — plus ops/discovery/edge/governance/build scanners on a 15-min scheduler)*
- [x] **Apply path**: each `Insight` maps to an existing `ActionDescriptor` (`actionDescriptors.ts`) where one exists; `POST /api/insights/:id/apply` runs it through `api/actions.ts`, writes `action_audit` (with `userId` + before/after), flips status to `applied`. Respect `confirm`/`reasonRequired`. Safe-only auto-suggest; risky → require approval (`governance/approvals.ts`). *(done — plus safe-tier auto-apply)*
- [x] `POST /api/insights/:id/dismiss` (with reason → audit). *(done)*
- [x] **Inbox UI** `app/routes/InsightsPage.tsx` + nav entry: grouped by domain, severity-sorted, each card = plain-English summary + confidence pill + evidence drawer + **Apply** + **Configure manually** (deep-links the relevant page) + **Dismiss**. Live (SSE/poll). Make it the new `DashHome` hero or top nav item — it's the demo opener. *(done)*
- [x] Tests: aggregation shape, scanner findings, apply→audit→status, dismiss, RBAC (auditor can view, not apply). Validation gate. *(done — insights suites green in the 914/0 full run, 2026-07-03)*

## Phase 3 — Builder proof beat (NO new consumer UI — Studio is deferred)

Goal: make the *already-real* agent-team build→audit→rollback loop demo-clean. No idea→app wizard (that's the separate Studio product, reserved until mature).

- [ ] On the seeded tenant, stage a Builder run that visibly: runs a pass → validation/doctor catches a real issue → rolls back. Use a real, repeatable scenario (the codex-auditor catching a bug is the story). *(OPEN — demo scenario not staged; builder loop itself is real)*
- [ ] `/agent-team` + `/builder` pages render this clearly for a non-technical viewer: plain-English status, "what it's doing right now," and the rollback shown as a *feature* (reversible, traced) — not a failure. *(OPEN — pages exist; non-technical narration pass not verified)*
- [x] Route build failures into the Insights Inbox (suggested actions, not stack traces) so even errors demo the "AI-led" promise. *(done — scanners/build.ts maps builder_runs failures to insights)*
- [ ] Validation gate. (Studio idea→app front door = post-showcase, separate product — see roadmap.) *(OPEN — pending the two items above)*

## Phase 4 — Plain-English UX on the 6 demo routes ONLY

Scope strictly to: `/` (DashHome), `/insights`, `/gateway` (Cost), `/agent-team`, `/builder`, `/governance`. Ignore the other 28.

- [ ] Every page: friendly empty states, helpful banners, no raw JSON/stack traces, action buttons where an action exists. *(OPEN — largely true after Phase 6 UX pass; needs a final leak sweep)*
- [ ] Cost page reframed for a **non-technical/CFO** eye: "You saved €X vs all-paid this month" headline + spend trend + top cost drivers + budget status. Source from `cost_events` / attribution. *(OPEN — savings API data exists (cost.ts opportunities); headline framing not on the page)*
- [x] Consistent table UX (finish the `useTableControls` pass already started in `TABLE_UX_FIX_PLAN.md`) on these 6 only. *(done — useTableControls adopted across 20 routes incl. the 6)*
- [ ] Mobile pass (iPhone 16 Pro viewport) on all 6. Validation gate. *(OPEN — multi-viewport Playwright pass scheduled)*

## Phase 5 — Showcase polish & proof

- [x] **Numbers slide data** pulled from AI Vault + DB: % LLM cost saved (free-first routing), bugs auto-caught by the auditor (use the real `mimule-job` rollback story), plan-completion rate, uptime. Expose a `/api/metrics/showcase` summary the deck can cite. *(done — /api/metrics/showcase live)*
- [ ] **Cold-install proof**: run `installer/install.sh` on a fresh VPS/container, record a 2-min "boots clean elsewhere" clip. De-risks "is this real?". *(OPEN — installer exists; fresh-container run not recorded)*
- [ ] Rehearse the golden demo flow end-to-end 10×; ensure it's deterministic on the seeded tenant and never crashes. *(OPEN — operator-facing rehearsal)*
- [ ] Final full validation gate + AI Vault + master-plan entry. *(OPEN — after Phases 3–5 close)*

---

## Out of showcase scope — the post-raise roadmap (SHOW, don't build)

These are the funded roadmap shown as trajectory, not pre-built:
- Full **Defender / Purview / Priva** admin-center surfaces (deep security posture, data inventory + DLP + lineage, PII inventory + DSAR/right-to-delete).
- **Social-media + website publishing connectors** for the Content Engine (X/LinkedIn/IG/FB), per-customer brand/voice profile, content approval calendar.
- Deep compliance posture (replace the doc-generator).
- Marketplace, Postgres adapter for scale, OIDC/SSO GA, air-gapped install.

---

## Exit criteria (showcase-ready)

- [x] `GET /api/version` shows a real commit + `production`. *(verified live 2026-07-03)*
- [x] A second, non-owner user can log in and is correctly role-gated (identity is real). *(demo-auditor@tib.local, auditor binding in governance_role_bindings, fail-closed login verified)*
- [x] Insights Inbox shows live findings across cost + security + build; ≥3 have a working one-click Apply that writes an attributed, reversible `action_audit` entry. *(live: security/cost/ops/discovery findings open; apply + auto-apply write audited entries)*
- [ ] The agent-team build → audit → rollback loop runs cleanly on the seeded tenant and reads as a *feature* (reversible/traced) to a non-technical viewer. *(OPEN — Phase 3)*
- [ ] The 6 demo routes have zero raw-JSON/stack-trace leaks and pass multi-viewport Playwright clean. *(OPEN — mobile/viewport pass scheduled)*
- [ ] Demo-seed makes the dashboard look alive; golden flow runs deterministically 10×. *(OPEN — rehearsal)*
- [x] Baseline tests still ≥260 pass / 0 fail; `bun run check` clean; service restarts clean. *(2026-07-03: 914 pass / 0 fail; check clean; clean journal after restart)*
