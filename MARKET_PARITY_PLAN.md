# Control Surface — Market Parity Plan (extended functionality roadmap)

**Created**: 2026-06-11 · **Owner**: Marouane Defili · **Author**: Claude (Fable 5)
**Repo**: `/opt/opencode-control-surface` · **Live**: control.techinsiderbytes.com
**Predecessor**: `SHOWCASE_SPINE_PLAN.md` (Phases 0–5 COMPLETE) and the Tier 2/3 backlog in `CONTROL_SURFACE_BRIEFING.md`.

---

## 0. Purpose & thesis

The showcase spine proved the product story: *AI analyzes → recommends in plain English → human clicks Apply → every action is traced and reversible.* This plan answers the next question: **what does it take for the Control Surface to stand next to the market-leading SaaS in each module category** — not feature-for-feature clones, but credible parity on the features buyers actually shortlist on, while keeping our three differentiators:

1. **Every action audited & reversible** (no leader makes this the spine like we do)
2. **Plain English everywhere** (no raw JSON, no stack traces)
3. **Free-first cost** (the Cost Firewall keeps LLM spend near zero by construction)

**Market context (researched 2026-06):** Microsoft shipped **Agent 365** (GA, $15/user/mo) as "the control plane for AI agents" — agent registry, agent identity, per-agent permissions, immutable audit. ServiceNow extended **AI Control Tower** into Microsoft's ecosystem. This validates the category HARD: the giants are selling exactly what we built. Our wedge stays: *they govern agents; ours **are** the workforce* — the same surface builds, ships, operates, and governs.

### The 6 market categories we map onto

| Our module | Market category | Leaders (2026) | Their shortlist features |
|---|---|---|---|
| Cost Firewall (`/gateway`, `/models`, `/litellm`) | AI Gateway + LLM FinOps | Portkey, Kong AI GW, LiteLLM Ent., CloudZero, Vantage, Finout | guardrails, PII redaction, virtual keys w/ budgets, fallback chains, semantic cache, chargeback/showback, unit economics, anomaly detection |
| Control Tower (`/governance`, `/audit`, `/settings`) | Agent governance / control plane | MS Agent 365, ServiceNow AI Control Tower | agent registry + identity, per-agent permissions & budgets, real-time agent inventory, immutable audit chain, compliance status |
| Autonomous Ops (`/agent-team`, `/doctor`, `/incidents`, `/insights`) | AIOps / incident mgmt | PagerDuty, incident.io | AI-drafted post-mortems, impact-ranked incidents, runbook automation, status pages, on-call/notify |
| Security surface (planned `/security`) | Security posture mgmt | MS Defender Secure Score | numeric posture score, ranked improvement actions w/ point values, score history, one-click remediation |
| Observability (`/traces` — labs) | LLM observability | Langfuse, LangSmith | tracing w/ spans, prompt management + versioning, evals (LLM-as-judge), datasets, playground, annotation |
| Platform itself | Multi-tenant SaaS chassis | all of the above | public API + keys, webhooks, SSO, exports, status page, onboarding, per-module licensing |

### What we already have that buyers can't see yet (exploit first, build second)

The DB has scaffolding far ahead of the UI: `provider_price_catalog`, `spend_anomalies`, `governance_budgets`, `notification_rules`, `runbooks`, `reasoner_playbooks`, `audit_export_jobs`, `report_runs`/`report_archive`, `marketplace_skills`, `sso_configs`, `tenants`/`tenant_settings`, `workspace_sessions`. Wiring existing tables to surfaces is 10× cheaper than new subsystems — most phases below are *completion*, not invention.

---

## Hard rules (every pass — inherited, non-negotiable)

- **Hand-build, clean single builds**: edit → `bun run typecheck` → `bun run build` → ephemeral boot check (`PORT=34xx DASHBOARD_DB=1 bun run server/index.ts &`, curl, kill) → `systemctl restart control-surface.service` → verify live (`curl :3000` + `/api/version`). **No Playwright on this box. Do NOT resume `mimule-jobd` or the enqueuer timers.**
- `DASHBOARD_DB=1 bun test` on touched modules — keep the pass baseline, 0 fails.
- Never touch `/opt/newsbites`. Studio stays held.
- Plain English everywhere; every new finding/insight gets evidence refs + Apply or manual-page link.
- Log meaningful passes to `/opt/ai-vault/daily/YYYY-MM-DD.md`.
- **Verify the LIVE product before checking any box below.**

---

## Phase A — Finish the committed backlog (prerequisite, from CONTROL_SURFACE_BRIEFING.md)

Everything later builds on the apply-path. Do these first; they are already specified.

- [x] **A1. Insights apply-path** ✅ 2026-06-11: `mutate-policy:budget:global:set-cap` handler (validated params, medium risk = confirm+reason), security scanner finding wired, verified end-to-end on LIVE (budget row `global-mimule` $5/$50 + attributed audit). Existing `route-healthiest`/`doctor:scan` ids already wired by aggregator.
- [x] **A2. Insight lifecycle (auto-resolve)** ✅ 2026-06-11: migration v6 (resolved status + resolved_at/resolution), `resolveStaleInsights` per scanner namespace, reopen-on-recurrence (never reopens applied/dismissed), system audit rows. Verified live: 4 stale insights auto-resolved; honest `slow/api/home` stays open while sentinel still flags it. (Fixed two builder bugs found in validation: mass-resolve on unreadable health file; positional-binding corruption in the UPDATE.)
- [x] **A3. Sentinel v2** ✅ 2026-06-11: agent-runner liveness in the sentinel — binary checks every tick, real round-trips max 1/6h (state in `/var/lib/mimule/agent-liveness.json`, atomic writes), codex NEVER invoked (quota guard), warn-only findings (no auto-fix enqueue), `agents` key in health card. Verified: opencode + gemini round-trips OK (≈11s each).
- [x] **A4. CFO cost headline on `/gateway`** ✅ 2026-06-11: `costHeadline` on `/api/gateway/status` + GatewayPage hero. Live: "100% of the last 234 model calls were routed to free models — estimated spend $0.00 in the last 30 days."
- [x] **A5. Defender-lite `/security` page** ✅ 2026-06-11: `GET /api/security/posture` (good/needs-attention/at-risk triage, reuses insights RBAC) + `SecurityPage.tsx` admin center (Apply/Dismiss via existing insights endpoints, resolved badges, plain English) + core nav entry. Live: posture "good", 5/5 checks passing.
- [x] **A6. Showcase metrics fix** ✅ 2026-06-11: `buildSuccessRate` removed from headline; `selfCorrectionRate` + `headlineSentence` ("15 builds audited — 9 shipped, 6 caught by the auditor and safely rolled back."); DashHome showcase tile wired.

> **Execution note (2026-06-11):** Phase A built via orchestrator workflow — nemotron-3-ultra-free (primary builder, best in benchmark), north-mini-code-free + gemini CLI (secondary lanes), gemini CLI review. Codex exhausted; minimax/deepseek/copilot lanes dead. Hard-won rules: worktree tar snapshot before dispatch, ADDITIVE-ONLY specs, `timeout` wrapper on every dispatch (Zen upstream wedges silently), validator must re-check DB state not just test counts (binding bug shipped past green tests). Backlog from review: `/api/gateway/status`+`/ledger` are unauthenticated (pre-existing posture — decide in Phase B); sentinel-guard regression test still to add; `slow/api/home` insight open pending genuine perf look.

---

## Phase B — Trust Score: the security center grows the Defender pattern (extends A5)

Defender's stickiest UX is the **Secure Score**: one number, ranked improvement actions each worth points, score history. We have all the inputs.

- [x] **B1. Trust Score engine** ✅ 2026-06-11 (10 weighted checks, /api/security/trust-score, daily metric_samples persistence) — (`server/security/score.ts`): compute 0–100 from weighted checks across the security scanner findings, governance posture (policies enforcing vs log-only, budgets set, 4-eyes enabled), secrets vault state, RBAC breadth, audit redaction. Each failed check = an improvement action with a point value and (where safe) an `action_descriptor_id`. Persist daily samples in `metric_samples` for the history graph.
- [x] **B2. `/security` page v2** ✅ 2026-06-11 (score dial, point-ranked improvement actions w/ Apply, history sparkline; live 80/100→75 with real findings) —: score dial + "improvement actions" list ranked by points, each with Apply (via A1 plumbing) or manual link + score history sparkline. This is the literal Defender pattern, AI-led.
- [x] **B3. Score in showcase** ✅ 2026-06-11 (trustScore in showcase headline) —: add `trustScore` to `/api/metrics/showcase`; sentinel asserts the score endpoint stays healthy.

**Verify**: score changes when a real control changes (e.g. apply a budget cap → score rises → audit row links the delta). Demo gold.

---

## Phase C — Cost Firewall to FinOps parity (the CFO module)

Leaders sell **unit economics, chargeback, anomaly alerts, budget enforcement**. We have `gateway_calls`, `provider_price_catalog`, `spend_anomalies`, `governance_budgets` — mostly unwired.

- [x] **C1. Cost attribution** ✅ 2026-06-11: ledger writes a cost_events row per call (`free-tier` at $0, `litellm-cost-estimate` when priced, `unpriced` when no data); idempotent boot backfill (`cost_backfill_v1` marker) — 234 historical calls backfilled live as `unpriced` (they recorded no token data — honest label). Note: `provider_price_catalog` is empty; pricing uses gateway config tier estimates.
- [x] **C2. Showback** ✅ 2026-06-11: `/api/gateway/showback` + GatewayPage section — by model / by caller / by cost-basis + counterfactual that says "not enough token data yet" instead of inventing a number. Live verified.
- [x] **C3. Budget enforcement loop** ✅ 2026-06-11: checkBudget gained pctUsed/warn; budget scanner emits warn at 80% and high-severity "cap reached, calls blocked" at 100% (one-click fix = raise cap via the audited A1 action), auto-resolve under `budget:`; gateway 429 blocks now write an audit row. Hard-stop was pre-existing; loop now observable end-to-end.
- [x] **C4. Spend anomaly detection** ✅ 2026-06-11: anomaly scanner (3× 7-day baseline with floors, deduped per day) writes `spend_anomalies`; existing aggregator turns them into cost insights. Scan pipeline now runs 5 engines per pass (aggregate/security/registry/budget/anomaly).
- [ ] **C5. Virtual keys (gateway parity)**: per-agent/per-project gateway keys with own budget + model allowlist (LiteLLM/Portkey's most-used enterprise feature). Tables: extend `governance_budgets` + new `gateway_keys`. **Deferred — next session.**

> **DIRECTIVE (Marouane, 2026-06-11): everything goes through the gateway** — chats, builder, agent team. Compliance must see all actions, responses, and calls; that is the point of governance. Execution plan:
> - **GW1** ✅→ C5 implemented as the enabler: `gateway_keys` (per-agent identity, model allowlist, per-key daily cap); `/v1/chat/completions` requires a key (or operator token) — no anonymous calls; caller = the agent identity, attributed in ledger + cost_events.
> - **GW2**: point the opencode CLI lanes (builder + chats) at the control-surface gateway via a custom provider (`http://127.0.0.1:3000/v1` + per-agent key) so agent builds flow through budget/circuit/ledger.
> - **GW3** ✅ 2026-06-12: `server/builder/runnerAccounting.ts` — non-gateway CLI runs (gemini/codex/claude) write attributed `cli-unmetered` cost_events + `cli-direct` gateway_calls rows on completion (deduped per run id); passports/showback see all runner activity.
> - **GW4 (needs explicit go, touches newsbites)**: autopipeline cloud stages re-based from :4000 to the gateway `/v1`.
>
> **DIRECTIVE EXTENSION (Marouane, 2026-06-11): all-seeing applies to ALL governance and auditing services**, not just model traffic. Concretely:
> - **GW5 — universal audit boundary**: router-level enforcement — every mutating `/api/*` request (POST/PUT/PATCH/DELETE) that completes 2xx without writing an `action_audit` row gets a fallback audit row written at the boundary (`api.unaudited-mutation`, actor from auth, path as target) and surfaces as a coverage finding. Nothing mutates silently, even endpoints that forgot to audit.
> - **GW6** ✅ 2026-06-12 (delivered inside GW5): Trust Score `actions-attributed` check goes unearned when boundary-caught `api.unaudited-mutation` rows exist in the last 7d, naming the offending endpoint as the improvement action.
> - Principle for every future slice: a feature isn't done unless its actions are attributed in `action_audit` and visible to compliance export.

**Verify**: run a real call through the gateway → cost event lands → showback updates → exceed a tiny test budget → call blocked + insight raised + audited override works.

---

## Phase D — Agent 365 parity: the agent registry (Control Tower's missing spine)

Microsoft's Agent 365 pitch = registry, identity, permissions, inventory, audit. We *run* real agents (builder workflows, autopipeline stages, codex/opencode/gemini runners) but have no single registry.

- [x] **D1. Agent registry** ✅ 2026-06-11: migration v7 `agents` table + `server/agents/registry.ts`, seeded with the 7 real agents (3 CLI runners incl. paused codex, sentinel, insights-scanner, reasoner, autopipeline), enriched with lastSeenAt/audit7d/spend30d from live audit+gateway joins.
- [x] **D2. `/agents` admin center** ✅ 2026-06-11: inventory with status/risk/owner/last-seen/spend + core nav. Live: 7 agents, real activity counts (sentinel & scanner 24 actions/7d each).
- [x] **D3. Agent passport** ✅ 2026-06-11 (folded into D1 API + D2 UI): `/api/agent-registry/:id` joins the agent's audit trail + gateway spend; rendered as the passport detail on /agents.
- [x] **D4. Registry scanner** ✅ 2026-06-11: unregistered actors / idle 30d / ownerless → insights with `registry:` auto-resolve namespace. LIVE PROOF: flagged the real `operator` actor as unregistered on first scan (true finding); pre-seed emissions for operator-bootstrap/reasoner/system auto-resolved once seeding registered them — the lifecycle self-corrected. **Backlog:** scanner should exclude known human users (users table) from "unregistered actor" — humans aren't agents; decide whether to register human identities separately.

**Verify**: every actor seen in the last 30 days of `action_audit`/`gateway_calls` resolves to a registry entry; the scanner proves it stays true.

---

## Phase E — Incident management to PagerDuty/incident.io standard

We have `reasoner_incidents`, `runbooks`, `reasoner_playbooks`, `notification_rules` — the bones of an incident product.

- [x] **E1. AI post-mortem drafts** ✅ 2026-06-12: on incident resolve, post-mortem generated via **gatewayComplete('editorial-cloud-heavy', caller 'incident-postmortem')** — the platform's own LLM use is governed/metered per the directive; stored in report_archive; GET /api/reasoner/incidents/:id/post-mortem. Best-effort (resolve succeeds even if LLM fails).
- [x] **E2. Impact-ranked incidents** ✅ 2026-06-12: sentinel `fail` findings auto-create reasoner_incidents (deduped per finding/day), demo-route failures ranked high.
- [x] **E3. Telegram notifications** ✅ 2026-06-12: notification_rules seeded; critical/high insights → one deduped plain-English Telegram alert each (audit row per send); creds via env drop-in using the stack's existing bot — /opt/mimoun untouched. END-TO-END VERIFIED (real message delivered).
- [x] **E4. Public status page** ✅ 2026-06-12: unauthenticated `/api/public-status` + `/status` page (plain English, mobile-first) fed by the sentinel's own scorecard incl. agent liveness. Live: "operational", score 90.

**Verify**: kill an allowlisted test service → incident auto-opens, Telegram fires, restart via Apply, post-mortem drafts on resolve, status page reflected throughout.

---

## Phase F — LLM observability (graduate `/traces` from labs)

Langfuse/LangSmith parity is a product of its own — **do not chase it all**. Take the 20% with demo value:

- [x] **F1. Real traces** ✅ 2026-06-12 (gateway traces grouped by trace_id/caller — /api/traces/gateway + graduated /traces page; live: 100 traces, opencode-runner 187k tokens) —: persist gateway + builder + autopipeline calls as spans (request, model, tokens, latency, cost, caller agent) — `/traces` becomes a working waterfall keyed to agents/jobs. Link spans → audit rows ("this trace caused this action").
- [x] **F2. Cheap evals** ✅ 2026-06-12 (daily 3-model eval + judge via governed gatewayComplete, scores → metric_samples source 'model-eval', deduped per day) —: nightly LLM-as-judge over a sample of gateway responses (free model judges free model output; quality score per model into `metric_samples`) → feeds Doctor + model-routing insights ("Model X quality dropped, route around it"). This closes the loop: observe → evaluate → recommend → apply.
- [x] **F3. Prompt registry (light)** ✅ 2026-06-12 (prompts table v9, content-hash versioning + diff, post-mortem system prompt registry-backed, /api/prompts) —: version the prompts our own agents use (builder, autopipeline stages) with diff view + "which prompt version produced this trace." Skip playground/annotation queues — that's Langfuse's moat, not ours.

**Verify**: pick one live autopipeline dossier run; its full trace tree, eval score, and prompt version are all visible and cross-linked.

---

## Phase G — SaaS chassis (what makes it *sellable*, not just demoable)

- [x] **G1. Public API + keys** ✅ 2026-06-12 (read-only /api/v1/* — insights, agents, audit redacted, trust-score, cost; gateway keys as credentials; 120/min rate limit; live-verified) —: versioned `/api/v1` surface (insights, agents, audit, cost read-paths first) with per-tenant API keys + scopes; auto-generated reference page at `/about` or `/docs`. Buyers integrate before they buy.
- [x] **G2. Webhooks** ✅ 2026-06-12 (migration v10; HMAC-SHA256 signed deliveries w/ retry + delivery log; fired on insight.critical / action.applied / incident.created; management API w/ masked secrets) —: `insight.created`, `action.applied`, `incident.opened`, `budget.exceeded` → tenant-configured URLs w/ HMAC signing + delivery log. (Also the integration story: Slack/Teams later become webhook consumers, not bespoke code.)
- [x] **G3. Tenant demo mode** ✅ 2026-06-12 (acme-demo tenant seeded behind DEMO_TENANT=1; isolation live-verified: 3 demo insights vs mimule's 17) —: second seeded tenant + tenant switcher proving isolation live (tables + `tenantScope.ts` exist and are tested — this is surface work). The "pick-your-modules" licensing gates shown per tenant.
- [x] **G4. SSO completion** ✅ 2026-06-12 (Google OIDC login/callback over existing sso_configs; invite-only, no auto-provisioning; same session cookie as local auth; needs client_id config to activate) —: wire the existing `sso_configs`/`sso_sessions` tables to one real OIDC provider (Google) for login next to local auth. Enterprise table stakes; mostly already scaffolded.
- [x] **G5. Compliance evidence export** ✅ 2026-06-12 (one-click pack: hash-chained redacted audit, access review, trust score, counts → report_archive + API; live pack id 15) —: one-click export pack — audit chain w/ hash verification, access review (users × roles × last login), policy decisions log, retention proof — from `audit_export_jobs` + `report_runs`. SOC2-adjacent evidence is a real procurement unblock and we uniquely already *have* the data.
- [x] **G6. Weekly operator digest** ✅ 2026-06-12 (real 7d numbers — trust delta, spend, insights lifecycle, incidents, top agents, best eval model; Telegram + report_archive; weekly marker; live digest DELIVERED) —: scheduled report (existing `report_runs` machinery): trust score delta, spend + counterfactual savings, incidents + auto-heals, agent activity — emailed/Telegram'd. The retention feature every SaaS leans on.

---

## Sequencing & demo value (recommended order)

| Order | Item | Why now | Effort |
|---|---|---|---|
| 1 | A1+A2 (apply-path + lifecycle) | the centerpiece must be real; everything reuses its plumbing | M |
| 2 | A4+A6 (cost headline, showcase fix) | demo polish, hours not days | S |
| 3 | A5→B (security center + Trust Score) | most recognizable "admin center" proof; Defender pattern | M |
| 4 | D (agent registry) | rides the Agent 365 market wave; cross-domain passport is unique | M |
| 5 | C (FinOps loop) | turns Cost Firewall from a name into enforcement | M–L |
| 6 | E (incidents + Telegram + status page) | visceral live demo (kill service → watch it heal & narrate) | M |
| 7 | G3+G1 (tenant demo, public API) | the "sellable bundle" proof for diligence | M |
| 8 | F (observability), rest of G | depth; post-funding or off-box team work | L |
| — | A3 (sentinel v2) | slot anytime; independent | S |

**Off-box note**: phases F and the heavier parts of C/G are good first assignments for the autonomous team **if/when builds move off-box** (Marouane's pending decision). Everything ranked 1–6 is hand-buildable in clean single builds on this box.

---

## Market research sources (2026-06)

- AI gateways: [Kong AI Gateway benchmark](https://konghq.com/blog/engineering/ai-gateway-benchmark-kong-ai-gateway-portkey-litellm), [Portkey buyers guide](https://portkey.ai/buyers-guide/ai-gateway-solutions), [AI gateway comparison](https://particula.tech/blog/ai-gateway-decision-litellm-portkey-kong-ai-gateway)
- LLM observability: [Langfuse](https://github.com/langfuse/langfuse), [Langfuse vs LangSmith](https://langfuse.com/faq/all/langsmith-alternative), [agent observability 2026](https://www.digitalapplied.com/blog/agent-observability-platforms-langsmith-langfuse-arize-2026)
- Agent governance: [Microsoft Agent 365](https://www.microsoft.com/en-us/microsoft-agent-365), [Agent 365 governance guide](https://zenvanriel.com/ai-engineer-blog/microsoft-agent-365-ga-enterprise-governance-guide/), [ServiceNow AI Control Tower × Microsoft](https://newsroom.servicenow.com/press-releases/details/2026/ServiceNow-expands-AI-agent-governance-through-deeper-integration-with-Microsoft/default.aspx)
- FinOps for AI: [FinOps for AI (CloudZero)](https://www.cloudzero.com/blog/finops-for-ai/), [FinOps tools 2026 (Finout)](https://www.finout.io/blog/best-finops-tools-for-managing-ai-costs-in-2026), [FinOps.org AI overview](https://www.finops.org/wg/finops-for-ai-overview/)
- Security posture: [Microsoft Secure Score](https://learn.microsoft.com/en-us/defender-xdr/microsoft-secure-score), [Secure Score optimization guide](https://www.coreview.com/blog/microsoft-secure-score-a-tactical-guide-to-implementation-configuration-and-optimization)
- Incident/AIOps: [AI incident management 2026 (incident.io)](https://incident.io/blog/5-best-ai-powered-incident-management-platforms-2026), [AIOps 2026](https://www.augmentcode.com/guides/what-is-aiops)
