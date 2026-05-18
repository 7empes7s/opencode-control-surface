# Control Surface Gap Plan — 2026-05-18

## Executive Summary

Estimated product reality after comparing the committed plan, source code, live UI, and API smoke tests:

- Real and usable: about 35%. Builder, audit/jobs tables, gateway status subpages, models inventory, traces, home, and several operational read views are wired to real stores and render live data.
- Partial product shells: about 25%. Today, infra, incidents, reports/compliance, agents, projects, channels, governance, settings, and cost have visible UI, but miss core data, actions, lifecycle, or error handling promised by the plan.
- Stub, broken, or aspirational: about 40%. Several pages call endpoints that are not routed, key report correctness tasks remain undone, many plan-required API surfaces and schemas do not exist, and "zero typing" / "nothing misunderstood" quality gates are not met.

The only true `[x]` implementation items in `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md` are the two late Builder bug fixes at `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:5741` and `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:5742`. Both are present in code:

- `readBuilderDoctorReports()` avoids the bad `WHERE AND` query by stripping leading `AND` and only adding `WHERE` when conditions exist (`server/builder/store.ts:746`, `server/builder/store.ts:748`).
- `builderArtifactContentHandler()` searches flat artifact paths, DB tenant/project paths, and run-directory fallbacks (`server/api/builder.ts:123`, `server/api/builder.ts:144`).

The broader `[x]` "Nothing Typed, Nothing Misunderstood" checklist at `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:4341` through `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:4350` is not met. The UI still contains raw text fields, native `confirm()` / `alert()` flows, hard-coded paths, and unclear empty states.

Largest gaps:

- Live route breakage from missing router wiring: `/litellm`, `/scout`, `/cost`, `/settings`, `/finance-intel`, and supporting controls call APIs that are absent from `server/api/router.ts`.
- API contract drift: smoke-tested endpoints `/api/gateway`, `/api/governance/audit`, `/api/builder/doctor/reports`, and `/api/cost` return 404.
- Today is not the promised command center: priorities are not top-5 ranked cards with evidence/actions, and core buttons are disabled.
- Reports are not trustworthy operator reports: `gateway-calls` still queries `action_audit`; `chain-verifier` does not recompute the hash chain; report artifacts/history/export formats are incomplete.
- Enterprise entity contract is mostly absent. The plan-required fields `status`, `freshness`, `evidence`, `impact`, `actions`, `risk`, `duration`, `rollback`, and `audit trail` are not implemented consistently across pages.
- Auth/RBAC is inconsistent. Browser cookie auth works for normal APIs but governance role lookup reads only `x-operator-token`, causing live 403s on `/governance`.

## P0 — Broken / Crashes the Page

### 1. Unwired API modules break live pages

What the plan claimed:

> "Every feature must tell the operator: what state the thing is in ... what action can be taken ..." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:57`)

> "Fix UI authFetch wrapper ... Inline 401/403 surfaces" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1615`)

What actually exists:

- `/api/litellm/*` handlers exist in `server/api/litellm.ts`, but `server/api/router.ts` does not import or route them. `LiteLLMPage` calls `/api/litellm/status`, `/api/litellm/routing`, and `/api/litellm/config` (`app/routes/LiteLLMPage.tsx:76`).
- `/api/scout/*` handlers exist in `server/api/scout.ts`, but are not routed. `ScoutPage` calls `/api/scout/runs` and `/api/scout/config` (`app/routes/ScoutPage.tsx:55`).
- `/api/finance-intel/*` handlers exist in `server/api/financeIntel.ts`, but are not routed. `FinanceIntelPage` calls `/api/finance-intel/stats`, `/runs`, `/enrichments`, and `/portfolio-configs` (`app/routes/FinanceIntelPage.tsx:69`).
- `/api/system-config` and `/api/system-config/history` are called by Settings (`app/routes/SettingsPage.tsx:149`, `app/routes/SettingsPage.tsx:164`) but are not routed. The handler file is also non-durable (`server/api/systemConfig.ts:83`).
- `/api/cost/summary` is called by Cost (`app/routes/CostPage.tsx:53`) but is not routed or implemented. Router only exposes specific cost subroutes (`server/api/router.ts:784`).
- `/api/fs/browse` is called by `FileBrowser` (`app/components/FileBrowser.tsx:38`) but is not routed.
- `/api/dossier/:date/:slug` is called by `DossierInspectorPage` (`app/routes/DossierInspectorPage.tsx:16`) but is not routed.
- Model routing endpoints exist as functions in `server/api/models.ts:115` onward, but `/api/models/routing-log`, `/api/models/routing-stats`, `/api/models/force-route`, and `/api/models/force-route/:logicalName` are not wired in `server/api/router.ts`.

Playwright found:

- `/litellm`: 404s for `/api/litellm/status`, `/api/litellm/routing`, and `/api/litellm/config`; visible `HTTP 404`; stuck `loading...`; screenshot `/tmp/cs-audit-screenshots/litellm.png`.
- `/scout`: 404 for `/api/scout/runs`; visible loading; screenshot `/tmp/cs-audit-screenshots/scout.png`.
- `/cost`: visible loading state; screenshot `/tmp/cs-audit-screenshots/cost.png`.
- `/settings`: visible loading state; screenshot `/tmp/cs-audit-screenshots/settings.png`.
- `/finance-intel`: visible loading state; screenshot `/tmp/cs-audit-screenshots/finance-intel.png`.

How to implement the fix:

- In `server/api/router.ts`, import and route the existing handlers for LiteLLM, Scout, Paperclip, Finance Intel, System Config, filesystem browse, dossier lookup, and model routing.
- Add a real `GET /api/cost/summary` handler in `server/api/cost.ts` that aggregates budgets, spend, Vast runway, fallbacks, and recommendations into the shape `CostPage` expects, or change `CostPage` to compose the existing granular endpoints.
- Add router tests that assert each rendered page's API calls return non-404 before shipping.
- Update `useApi` and `useAuthApi` to fail closed on `!response.ok` so missing endpoints surface as page errors instead of infinite loading.

### 2. Public API contract drift: smoke-tested endpoints return 404

What the plan claimed:

> "Dashboard API Surface Required" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1222`)

> "reports list, run, detail, download, schedule" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:375`)

What actually exists:

- Gateway routes are only `/api/gateway/status`, `/api/gateway/models`, `/api/gateway/ledger`, and `/api/gateway/stats` (`server/api/router.ts:491`).
- Governance routes include `/api/governance/policies`, `/api/governance/secrets`, `/api/governance/budgets`, and `/api/governance/retention`, but no `/api/governance/audit` (`server/api/router.ts:520`).
- Builder doctor reports route is `/api/builder/doctor-reports`, not `/api/builder/doctor/reports` (`server/api/router.ts:447`).
- Cost routes are granular and omit `/api/cost` (`server/api/router.ts:784`).

Playwright/API smoke found:

- `GET /api/gateway`: 404 `{"error":"not found"}`.
- `GET /api/governance/audit`: 404 `{"error":"not found"}`.
- `GET /api/builder/doctor/reports`: 404 `{"error":"not found"}`.
- `GET /api/cost`: 404 `{"error":"not found"}`.

How to implement the fix:

- Add compatibility aliases in `server/api/router.ts`:
  - `/api/gateway` should call the gateway status/summary handler and include links/counts to ledger, models, and stats.
  - `/api/governance/audit` should return governance-relevant audit events from `action_audit`, policy changes, budget changes, and secret events.
  - `/api/builder/doctor/reports` should alias `builderDoctorReportsHandler`.
  - `/api/cost` should alias the new cost summary handler.
- Add smoke tests under the existing server test setup for the exact endpoints listed above.

### 3. Governance page fails for cookie-authenticated browser sessions

What the plan claimed:

> "Add authFetch wrapper in UI and replace raw fetches for protected APIs" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1680`)

> "Inline 401/403 surfaces for protected APIs" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1681`)

What actually exists:

- `/api/auth/session` sets the `operator_session` cookie (`server/api/actions.ts:90`).
- Most protected APIs accept either `x-operator-token` or `operator_session` through `checkToken` (`server/api/actions.ts:67`).
- Governance role lookup ignores the cookie and reads only `x-operator-token` (`server/api/governance.ts:19`).
- `useAuthApi` does not throw on non-OK responses, so 403 payloads become undefined data and loading/empty states (`app/hooks/useAuthApi.ts:34`).

Playwright found:

- `/governance`: 403 for `/api/governance/secrets`; visible loading; screenshot `/tmp/cs-audit-screenshots/governance.png`.

How to implement the fix:

- Change `getGovernanceRole(req)` in `server/api/governance.ts` to use the same cookie/header token check as `checkToken`, then map authenticated operators to the configured governance role.
- Expand `server/governance/rbac.ts` roles to match the plan's `viewer`, `operator`, `engineer`, `admin`, and `automation` model or update the plan to match reality.
- Update `useAuthApi` to:
  - call `authFetch`;
  - throw on `!response.ok`;
  - expose status code and error body to pages.
- Render a real inline 403 panel on `GovernancePage` with the missing permission and required role.

### 4. Reports/compliance cannot be trusted as audit artifacts

What the plan claimed:

> "Report output contract: summary, findings, source rows, evidence links, actions, CSV/JSON/Markdown export, schedule metadata, Telegram share payload." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:405`)

> "gateway-calls should query gateway_calls not action_audit" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1611`)

> "chain-verifier should actually verify hash chain integrity" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1612`)

What actually exists:

- Report runs are synchronous and return `ok({ runId, output })` (`server/api/reports.ts:41`).
- Downloads are CSV only (`server/api/reports.ts:134`).
- Empty CSV uses a generic `No data` row (`server/api/reports.ts:161`).
- `gateway-calls` still queries `action_audit WHERE action_kind = 'gateway.call'` (`server/reporting/templates/gateway-calls.ts:13`).
- `chain-verifier` only checks that `row_hash` exists and does not recompute row hashes or validate `prev_hash` continuity (`server/reporting/templates/chain-verifier.ts:21`).
- `CompliancePage` stores the last report in client state and downloads CSV from memory (`app/routes/CompliancePage.tsx:71`, `app/routes/CompliancePage.tsx:123`).

Playwright found:

- `/compliance`: visible `Loading templates...` after the audit wait; screenshot `/tmp/cs-audit-screenshots/compliance.png`.

How to implement the fix:

- Add a durable `report_artifacts` table in `server/db/dashboard.ts` with `run_id`, `template_id`, `tenant_id`, `format`, `path`, `summary_json`, `source_status_json`, and timestamps.
- Change `server/api/reports.ts` to create queued report runs, persist JSON output, and expose `/api/reports/runs`, `/api/reports/runs/:id`, and `/api/reports/runs/:id/download?format=csv|json|md`.
- Fix `server/reporting/templates/gateway-calls.ts` to query `gateway_calls` and return call IDs, model, provider, tokens, latency, fallback reason, and timestamp.
- Fix `server/reporting/templates/chain-verifier.ts` to recompute `sha256(prev_hash + canonical_payload)` for each audited row and return broken links.
- Update `CompliancePage` to show report history, source freshness, degraded source flags, and durable download links.

### 5. Cost page is broken and cost intelligence is mocked

What the plan claimed:

> "what cost/risk/impact it carries" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:63`)

> "Models Page ... daily usage/cost by provider/model" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:240`)

What actually exists:

- `CostPage` calls `/api/cost/summary`, which is not implemented (`app/routes/CostPage.tsx:53`).
- Budget usage uses a hard-coded demo `30%` (`app/routes/CostPage.tsx:133`).
- `getVastRunway()` returns mock `$50` and `$0.138/hr` values (`server/api/cost.ts:275`).
- `getRecommendations()` returns mock recommendations (`server/api/cost.ts:418`).
- Attribution parsing is wrong for route-shaped URLs: `entityType = url.pathname.split("/").pop()` returns the entity ID, not the entity type (`server/api/cost.ts:311`).

Playwright found:

- `/cost`: no useful data, visible loading state; screenshot `/tmp/cs-audit-screenshots/cost.png`.
- API smoke: `GET /api/cost` returned 404.

How to implement the fix:

- Add `GET /api/cost/summary` and `GET /api/cost` in `server/api/cost.ts`.
- Populate summary from `provider_spend`, `cost_budgets`, `cost_allocations`, `gateway_calls`, and Vast/GPU telemetry.
- Fix attribution route parsing to read `/api/cost/attribution/:entityType/:entityId` path segments.
- Replace mocked runway with configured Vast balance or mark the source as degraded with `sourceStatus`.
- Replace hard-coded budget usage in `CostPage` with returned `spent / limit`.

### 5A. Projects page breakage is P0, not only incomplete CRUD

What the plan claimed:

> "Project discovery ... discover all, analyze, refresh AI, candidates." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:3101`)

What actually exists:

- `GET /api/projects` returns `400 {"error":"tenantId query param required"}` when called exactly as the page/API smoke does.
- `ProjectsPage` is therefore stuck in a loading/error state before the operator reaches create/edit/delete or discovery flows.
- The existing P1 item "Projects page lacks the promised project discovery and analysis API" is correct on product depth, but the live page breakage should be treated as P0 until `GET /api/projects` works with the current tenant context.

Live/API check:

- `GET /api/projects`: 400 `{"error":"tenantId query param required"}`.

How to implement the fix:

- In `projectsListHandler`, default `tenantId` from `getCurrentTenantContext()` or the existing tenant middleware when the query parameter is absent.
- Keep `tenantId` as an optional filter for admin views, not a required browser-page parameter.
- Add a router/page smoke test that loads `/projects` and asserts the first `GET /api/projects` is non-4xx.

### 5B. Autopipeline dossier inspector has a second page-breaking route bug

What the plan claimed:

> "Pipeline Page ... open dossier evidence" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:217`)

What actually exists:

- The missing `/api/dossier/:date/:slug` router wiring is already captured above, but the UI handoff is also wrong.
- `AutopipelinePage` derives `date` with `item.id.split("T")[0]` (`app/routes/AutopipelinePage.tsx:187`). Live queue IDs are shaped like `story-1777979607071-c1rc`, so the computed "date" becomes the story ID, not a `YYYY-MM-DD` dossier directory.
- `DossierInspectorPage` then calls `/api/dossier/${date}/${slug}` (`app/routes/DossierInspectorPage.tsx:16`), so the inspect flow would still miss real dossiers even after routing `server/api/dossier.ts`.

How to implement the fix:

- Add canonical `dossierDate`, `dossierSlug`, and `dossierPath` fields to the autopipeline queue response.
- Route `GET /api/dossier/:date/:slug` and `POST /api/dossier/:date/:slug/inject` to `server/api/dossier.ts`.
- Change the inspect button to use returned dossier metadata, not an inferred date from queue ID.

## P1 — Missing Core Functionality

### 6. Today is not the promised operator command center

What the plan claimed:

> "Today is the single answer to: what needs my attention right now?" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:128`)

> "Top 5 priorities ranked by severity, recency, blast radius." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:132`)

> "Every priority card has evidence + one primary action + safe dismissal." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:154`)

What actually exists:

- `TodayPage` renders many summary panels before the priority deck; the deck is not the first operational object (`app/routes/TodayPage.tsx:57`).
- `PriorityDeck` shows 3 cards before expansion, not top 5 (`app/components/PriorityDeck.tsx:66`).
- Priority cards contain severity, title, description, and a link, but no evidence drawer, risk, duration, rollback, or audit metadata (`app/components/PriorityDeck.tsx:16`).
- Today action buttons are disabled "coming in V4.1" (`app/routes/TodayPage.tsx:260`).
- Today API hard-codes or synthesizes key data: `failed: 0`, degraded labels as repeated strings, no recent restarts (`server/api/today.ts:85`, `server/api/today.ts:190`, `server/api/today.ts:192`).

Playwright found:

- `/today`: visible `FAILED`, `loading priorities...`, and `loading workload data...`; screenshot `/tmp/cs-audit-screenshots/today.png`.

How to implement the fix:

- Create a real priority service in `server/api/missionControl.ts` that joins incidents, failed jobs, model health, infra health, builder doctor reports, budgets, and audit events.
- Return priority objects with `{id, entityType, entityId, severity, rankReason, evidence[], primaryAction, dismissAction, risk, duration, rollback, auditTrail}`.
- Update `PriorityDeck` to show exactly top 5 by default and open an evidence/action drawer.
- Wire Today actions through existing action endpoints with preflight, blast radius, and audit logging.

### 7. Production page and Reports page promised by target nav do not exist

What the plan claimed:

> "Target top nav: Today, Production, Pipeline, Models, Infra, Agents, Builder, Reports, Incidents, Audit, Settings." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:92`)

> "Production Page ... Can answer: are TIB, NewsBites, Paperclip, Mimule healthy and producing output?" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:162`)

What actually exists:

- `app/App.tsx` defines `/today`, `/autopipeline`, `/models`, `/infra`, `/incidents`, `/audit`, `/builder`, and many labs routes, but no `/production` or `/reports` route (`app/App.tsx:63`).
- The sidebar still exposes `Marketplace`, `Compliance`, `Governance`, `Gateway`, `Projects`, `Workflows`, `Traces`, `Scout`, `Channels`, `Cost`, `Finance Intel`, and `About` as normal navigation entries (`app/components/DashSidebar.tsx:53`).
- `CORE_NAV.concat(ADVANCED_NAV)` is rendered in the top nav (`app/components/DashSidebar.tsx:185`).

Playwright found:

- All requested sidebar routes resolve as routes, but several are labs/advanced shells. There is no live route for the plan's `Production` or consolidated `Reports` page.

How to implement the fix:

- Add `ProductionPage` at `app/routes/ProductionPage.tsx` and route `/production` in `app/App.tsx`.
- Add `ReportsPage` as the durable report center and route `/reports`.
- Update `app/lib/navRegistry.ts` and `app/components/DashSidebar.tsx` so target nav is default and advanced/labs pages move behind an Advanced drawer or settings flag.

### 8. Required Entity Contract is not implemented across pages

What the plan claimed:

> "Every meaningful row/card/entity must expose status, freshness, evidence, impact, actions, risk, duration, rollback, audit trail." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:57`)

What actually exists:

- Workload entries include ID, type, title, status, timestamps, model/provider sometimes, and progress, but no evidence links, rollback, action safety, or audit trail (`server/api/workload.ts:40`).
- Infra services show restart controls without full blast radius/rollback/runbook context (`app/routes/InfraPage.tsx:47`, `app/routes/InfraPage.tsx:56`).
- Builder run rows, jobs, audits, traces, and model rows use table data but do not consistently expose source freshness or evidence.
- Core DB schema lacks general entity/evidence/link tables. Search found no `entities`, `entity_links`, `evidence_items`, `ai_runs`, `ai_spans`, `tool_calls`, `network_events`, `risk_events`, `report_artifacts`, `log_entries`, `deploy_events`, `scheduled_tasks`, or `alerts` tables in `server/db/dashboard.ts`.

Playwright found:

- Many pages render tables, but evidence/actions are not consistently visible. Examples: `/jobs`, `/audit`, `/traces`, `/models`, `/gateway`, and `/builder` show rows without plan-level entity affordances.

How to implement the fix:

- Add an entity registry and evidence model in `server/db/dashboard.ts`.
- Add helper APIs in `server/api/entities.ts`:
  - `GET /api/entities/:type/:id`
  - `GET /api/entities/:type/:id/evidence`
  - `GET /api/entities/:type/:id/actions`
  - `GET /api/entities/:type/:id/audit`
- Create shared frontend components `EntityStatusPill`, `FreshnessBadge`, `EvidenceDrawer`, `SafeActionButton`, and `AuditTrailDrawer`.
- Gradually retrofit Today, Workload, Infra, Models, Builder, Incidents, and Reports to consume the same contract.

### 9. Workload graph is a partial table, not cross-system workload intelligence

What the plan claimed:

> "Workload Graph is the nervous system. The operator should know what agents are doing, which models they used, which jobs succeeded, and what output they produced." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1315`)

What actually exists:

- `WorkloadGraphTable` is a filterable table, not a graph (`app/components/WorkloadGraphTable.tsx:16`).
- Data comes from jobs, builder runs, and the current pipeline only (`server/api/workload.ts:40`).
- Jobs, builder runs, and pipeline entries often set `modelUsed: null` (`server/api/workload.ts:72`, `server/api/workload.ts:87`, `server/api/workload.ts:102`).
- No pagination/cursor; server reads fixed limits and client filters locally (`server/api/workload.ts:46`, `app/components/WorkloadGraphTable.tsx:42`).
- No dossiers, articles, Paperclip tasks, agent sessions, tool calls, API calls, artifacts, or evidence links.

Playwright found:

- `/today`: workload component still showed `loading workload data...` after the route wait.
- API smoke: `/api/workload` returned 225 entries, so backend data exists but the UX is incomplete.

How to implement the fix:

- Create `workloads`, `workload_edges`, and `workload_artifacts` tables.
- Ingest jobs, builder runs, agent sessions, Paperclip tasks, dossiers, article publishes, gateway calls, and report runs into the workload graph.
- Add `cursor`, `limit`, `status`, `entityType`, `model`, and `timeRange` query parameters to `/api/workload`.
- Replace `WorkloadGraphTable` with a table plus entity graph drawer. Keep the table for scanning but add links to upstream/downstream artifacts.

### 10. Infra page lacks the promised operational coverage

What the plan claimed:

> "Infra Page ... covers VPS, services, timers, ports, Docker containers, Caddy/Cloudflare, Vast GPU, backups." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:267`)

What actually exists:

- Backend returns host stats, services, timers, Vast, and GPU (`server/api/infra.ts:15`).
- Frontend renders Hetzner, GPU, Vast, services, and timers (`app/routes/InfraPage.tsx:28`).
- Missing Docker containers, Caddy/Cloudflare, port/public URL inventory, backup verification, logs, runbooks, and incident links.
- Restart modal describes downtime but does not show dependencies, rollback, recent deploys, or active incidents (`app/routes/InfraPage.tsx:56`).

Playwright found:

- `/infra`: no 404s, but visible loading text after the audit wait; screenshot `/tmp/cs-audit-screenshots/infra.png`.

How to implement the fix:

- Extend `server/api/infra.ts` with collectors for Docker, Caddy config/status, Cloudflare tunnel/DNS, ports, backup status, and journal excerpts.
- Add `sourceStatus` per collector instead of one generic infra envelope.
- Add `runbookUrl`, `rollbackCommand`, `dependencies`, `lastRestart`, `lastDeploy`, and `activeIncidentIds` to service rows.
- Require restart preflight through a shared safe-action endpoint.

### 11. Incident lifecycle is incomplete

What the plan claimed:

> "Incidents ... Open, acknowledge, assign, link evidence, resolve, postmortem-lite." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:456`)

What actually exists:

- `IncidentsPage` uses `/api/reasoner/incidents`, not `/api/incidents` (`app/routes/IncidentsPage.tsx:223`).
- `/api/incidents` builds entries from pipeline alerts and doctor abandon events, but lacks owner, acknowledgement, timeline, evidence links, or postmortem state (`server/api/incidents.ts:1`).
- Empty state is generic: `No incidents yet — diagnoses queue as passes fail` (`app/routes/IncidentsPage.tsx:277`).

Playwright found:

- `/incidents`: no API errors, but visible loading text after the audit wait; screenshot `/tmp/cs-audit-screenshots/incidents.png`.

How to implement the fix:

- Add `incidents`, `incident_events`, `incident_evidence`, and `incident_assignments` tables.
- Route `IncidentsPage` to `/api/incidents` once it supports lifecycle state.
- Implement actions: acknowledge, assign, link evidence, resolve, reopen, create postmortem note.
- Connect Today priorities and service/model rows to active incident IDs.

### 12. Models page lacks routing, cooldown, and cost controls promised by the plan

What the plan claimed:

> "Models Page ... canonical model inventory, LiteLLM logical names, provider availability, cooldown/rate limits, GPU/Vast state, daily usage/cost by provider/model." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:230`)

What actually exists:

- `modelsHandler` reads `/var/lib/mimule/model-health.json` and returns inventory, logical models, and derived stats (`server/api/models.ts:37`).
- `cooldowns` and `discoveryLog` are hard-coded empty arrays (`server/api/models.ts:103`, `server/api/models.ts:106`).
- Routing inspection and force-route handlers exist but are not wired in `server/api/router.ts` (`server/api/models.ts:115`).
- If the model-health file is unreadable, the handler returns 500 rather than a degraded source envelope (`server/api/models.ts:47`).

Playwright found:

- `/models`: renders many rows and no 404s, but plan-required cooldown and routing controls are incomplete; screenshot `/tmp/cs-audit-screenshots/models.png`.

How to implement the fix:

- Wire model routing endpoints in `server/api/router.ts`.
- Store model discovery events, cooldowns, and routing decisions in DB tables.
- Return degraded `sourceStatus` when the model-health file is missing instead of failing the entire page.
- Join gateway cost/token stats into model rows.

### 13. Agent pages are not zero-typing operator tools

What the plan claimed:

> "Native confirm(), prompt(), alert() must not be used." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1638`)

> "No text input for a path if there is a safe picker option." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:4345`)

What actually exists:

- Native dialogs remain:
  - `app/routes/GeminiPage.tsx:243`
  - `app/routes/GeminiPage.tsx:271`
  - `app/routes/ClaudePage.tsx:206`
  - `app/routes/CodexPage.tsx:210`
  - `app/components/OpenCodeView.tsx:64`
  - `app/routes/BuilderPage.tsx:965`
  - `app/routes/BuilderPage.tsx:1453`
  - `app/routes/BuilderPage.tsx:1617`
  - `app/routes/SettingsPage.tsx:203`
  - `app/routes/SettingsPage.tsx:207`
- Agent pages still expose raw working-directory fields with `/opt/newsbites` defaults (`app/routes/GeminiPage.tsx:82`, `app/routes/ClaudePage.tsx:82`, `app/components/OpenCodeView.tsx:145`).

Playwright found:

- `/claude`: visible `Anthropic credits exhausted` and `no sessions yet`; screenshot `/tmp/cs-audit-screenshots/claude.png`.
- `/gemini`: visible `no sessions yet`; screenshot `/tmp/cs-audit-screenshots/gemini.png`.
- `/codex`: renders live session content, but raw terminal/session text dominates; screenshot `/tmp/cs-audit-screenshots/codex.png`.

How to implement the fix:

- Replace native dialogs with the existing modal pattern used by auth and action preflight.
- Replace path inputs with workspace/project pickers backed by `/api/projects` and `/api/fs/browse`.
- Add safe action metadata to agent operations: model, cwd, expected duration, risk, rollback, and audit event.
- Normalize agent pages around one shared `AgentControlSurface` component.

### 14. Builder is real, but still misses plan-level product controls

What the plan claimed:

> "Builder Page ... create/edit/validate/run workflows, inspect artifacts, doctor reports, locks, schedules." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:338`)

> "Detected Plan Picker" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:3509`)

What actually exists:

- Builder data is relatively complete: workflows, runs, artifacts, doctor reports, and project locks are present (`server/api/router.ts:424`, `server/db/dashboard.ts:373`).
- The two explicit bug fixes are implemented (`server/builder/store.ts:746`, `server/api/builder.ts:123`).
- There is no routed `/api/builder/detected-plans` endpoint visible in `server/api/router.ts`.
- Brainstormer and richer plan generation flows described in the plan do not exist as routed product surfaces.
- Builder still uses raw confirmation/alert flows (`app/routes/BuilderPage.tsx:965`, `app/routes/BuilderPage.tsx:1453`, `app/routes/BuilderPage.tsx:1617`).

Playwright found:

- `/builder`: renders real tables with many workflows, runs, artifacts, and projects; screenshot `/tmp/cs-audit-screenshots/builder.png`.

How to implement the fix:

- Add detected plan discovery endpoints and UI:
  - `GET /api/builder/detected-plans`
  - `POST /api/builder/detected-plans/:id/import`
  - `POST /api/builder/detected-plans/:id/ignore`
- Replace native dialogs with preflight modals.
- Add stale-lock detection and unlock flow using `builder_locks` and `project_locks`.
- Decide whether Brainstormer is in scope for this dashboard version; if yes, add routes and APIs, otherwise move it out of the committed plan.

### 15. Settings page is a non-durable shell

What the plan claimed:

> "Settings Page ... operator profile, auth/session, workspace registry, model preferences, notification preferences, safe action defaults." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:505`)

What actually exists:

- `SettingsPage` calls `/api/system-config` and `/api/system-config/history`, but router does not wire either endpoint (`app/routes/SettingsPage.tsx:149`, `app/routes/SettingsPage.tsx:164`).
- It fetches a filesystem path directly from the browser: `/var/lib/mimule/workspace-registry.json` (`app/routes/SettingsPage.tsx:176`).
- `server/api/systemConfig.ts` returns hard-coded defaults (`server/api/systemConfig.ts:4`) and does not persist changes (`server/api/systemConfig.ts:83`).
- Native `alert()` is used for save success/error (`app/routes/SettingsPage.tsx:203`, `app/routes/SettingsPage.tsx:207`).

Playwright found:

- `/settings`: visible loading; screenshot `/tmp/cs-audit-screenshots/settings.png`.

How to implement the fix:

- Route system config handlers in `server/api/router.ts`.
- Persist settings to SQLite or a controlled config file with versioned history.
- Replace direct browser filesystem fetch with `GET /api/workspaces`.
- Add validation schemas for model preferences, notifications, safe-action defaults, and workspace registry changes.
- Replace alerts with inline toasts/status panels.

### 16. Projects page lacks the promised project discovery and analysis API

What the plan claimed:

> "Project discovery ... discover all, analyze, refresh AI, candidates." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:3101`)

What actually exists:

- Router exposes only `/api/projects`, `/api/projects/detect`, and `/api/projects/:id` (`server/api/router.ts:694`).
- Missing `/api/projects/discover-all`, `/api/projects/analyze`, `/api/projects/:id/refresh-ai`, and `/api/projects/candidates`.

Playwright found:

- `/projects`: API error 400 for `/api/projects`; visible `Loading...`; screenshot `/tmp/cs-audit-screenshots/projects.png`.

How to implement the fix:

- Implement the missing endpoints in `server/api/projects.ts`.
- Make `GET /api/projects` tolerant of absent query parameters.
- Add project cards with freshness, language/framework detection, last run, linked workflows, and safe refresh actions.

### 16A. Brainstormer section contains checked template boxes, but Brainstormer does not exist

What the plan claimed:

> "Add a new Brainstormer page at `/brainstorm`." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:3144`)

> "POST /api/brainstorm/sessions ... GET /api/builder/detected-plans" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:3366`)

What actually exists:

- No `/brainstorm` route is registered in `app/App.tsx`; the route list jumps through existing pages such as `/scout`, `/builder`, `/marketplace`, `/finance-intel`, and `/channels` (`app/App.tsx:63`).
- No Brainstormer item exists in the sidebar nav (`app/components/DashSidebar.tsx:53`).
- `server/api/router.ts` has no `/api/brainstorm/*` routes and no `/api/builder/detected-plans` route.
- The only literal `[x]` lines inside Section 37 are placeholders inside a generated-plan template, not completed product work (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:3260`, `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:3275`, `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:3298`).

Live/API check:

- `GET /api/brainstorm/sessions`: 404 `{"error":"not found"}`.
- `GET /api/builder/detected-plans`: 404 `{"error":"not found"}`.

How to implement the fix:

- Add `BrainstormerPage` at `app/routes/BrainstormerPage.tsx`, route `/brainstorm` in `app/App.tsx`, and add the nav entry behind Builder.
- Add `server/api/brainstorm.ts` and wire the Section 37 routes in `server/api/router.ts`.
- Add DB tables for `brainstorm_sessions`, `brainstorm_findings`, `brainstorm_plan_drafts`, and Builder handoff links.
- Replace the checked template placeholders with unchecked template examples, or move them into fenced code so they are not counted as implementation checkboxes.

### 16B. The checked "Nothing Typed" quality gate is false-positive

What the plan claimed:

> "No text field where a dropdown, picker, or autocomplete is possible." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:4341`)

> "No raw cron expression where a human-readable scheduler is possible." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:4342`)

> "No raw filesystem path where a file browser is possible." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:4343`)

> "No raw model ID where a logical model name picker is possible." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:4345`)

What actually exists:

- Settings still uses raw text inputs for model override and pipeline-stage model (`app/routes/SettingsPage.tsx:457`, `app/routes/SettingsPage.tsx:498`).
- Settings fetches a filesystem path directly from the browser instead of using an API-backed workspace picker (`app/routes/SettingsPage.tsx:176`).
- Builder still allows custom raw cron expressions (`app/routes/BuilderPage.tsx:627`, `app/routes/BuilderPage.tsx:629`).
- Builder project creation still has raw plan-file path, Git URL, tag, owner, internal URL, and public URL fields (`app/routes/BuilderPage.tsx:1975`, `app/routes/BuilderPage.tsx:1982`, `app/routes/BuilderPage.tsx:1986`, `app/routes/BuilderPage.tsx:1991`, `app/routes/BuilderPage.tsx:1997`).
- Channels notification rules require raw JSON and CSV channel strings (`app/routes/ChannelsPage.tsx:384`, `app/routes/ChannelsPage.tsx:398`, `app/routes/ChannelsPage.tsx:450`, `app/routes/ChannelsPage.tsx:457`).
- Marketplace installs require raw bundle paths and manifest JSON (`app/routes/MarketplacePage.tsx:197`, `app/routes/MarketplacePage.tsx:206`).
- Compliance DPA generation requires a raw customer-name text field (`app/routes/CompliancePage.tsx:438`).

Live/API check:

- The API for some picker-style controls exists only partially. `FileBrowser` calls `/api/fs/browse` (`app/components/FileBrowser.tsx:39`), but that route is not wired in `server/api/router.ts`.
- `GET /api/system-config`: 404, so the Settings controls are not live even before zero-typing concerns.

How to implement the fix:

- Add a form-control inventory test that fails CI on raw path/model/service/cron fields unless explicitly allowlisted.
- Wire `/api/fs/browse` and convert remaining path inputs to `FileBrowser`.
- Replace cron text with a scheduler component that stores cron internally but presents intervals, weekdays, time, and timezone.
- Replace model text inputs with logical model dropdowns from `/api/models`.
- Replace Channels JSON/CSV fields with typed rule templates, severity/channel multi-selects, and threshold builders.

### 16C. Report catalog is missing the required operator report types

What the plan claimed:

> "Required reports: Daily Operator Brief, Editorial Production Report, Pipeline Queue Report, Model Reliability and Cost Report, Infrastructure Reliability Report, Agent Work Report, Incidents and Remediation Report, Audit Export." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:372`)

What actually exists:

- `REPORT_TEMPLATES` exposes 5 audit/compliance-style templates only: `gateway-calls`, `denied-actions`, `secret-accesses`, `user-activity`, and `chain-verifier` (`server/reporting/index.ts:8`).
- None of the 7 operator/product reports exist as templates: Daily Operator Brief, Editorial Production, Pipeline Queue, Model Reliability and Cost, Infrastructure Reliability, Agent Work, or Incidents and Remediation.
- `GET /api/reports` returns 404; only `/api/reports/templates`, `/api/reports/run`, `/api/reports/:id`, and `/api/reports/:id/csv` are routed (`server/api/router.ts:727`).

Live/API check:

- `GET /api/reports`: 404 `{"error":"not found"}`.

How to implement the fix:

- Add the 8 required templates to `server/reporting/index.ts`, backed by the real sources named in Section 10.2.
- Add `GET /api/reports` as the report-center summary: templates, recent runs, schedules, and export capabilities.
- Keep the current audit templates, but classify them under the Audit Export report instead of treating them as the whole report system.

### 16D. Public API contract drifts from implemented internal routes

What the plan claimed:

> "Dashboard API Surface Required" (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1222`)

What actually exists:

- `GET /api/autopipeline/queue` returns 404 even though the page consumes queue data inside `GET /api/autopipeline` (`server/api/autopipeline.ts:72`).
- `GET /api/newsbites/articles` returns 404 even though article state is embedded in `GET /api/newsbites` (`server/api/newsbites.ts:36`).
- `GET /api/marketplace/bundles` returns 404; the implementation is named skills instead (`server/api/router.ts:713`).
- `GET /api/settings` returns 404; settings are split across `/api/settings/auth-status`, `/api/settings/state`, missing `/api/system-config`, and missing `GET /api/telemetry/consent`.
- `GET /api/workflows` does not go through `server/api/router.ts`; it is intercepted in `server/index.ts:217` and reads a separate `data/workflows.db` table (`server/db/workflows.ts:3`) that is unrelated to `WorkflowsPage`, which uses `/api/orchestrator/instances` (`app/routes/WorkflowsPage.tsx:295`).

Live/API check:

- `GET /api/autopipeline/queue`: 404 `{"error":"not found"}`.
- `GET /api/newsbites/articles`: 404 `{"error":"not found"}`.
- `GET /api/marketplace/bundles`: 404 `{"error":"not found"}`.
- `GET /api/settings`: 404 `{"error":"not found"}`.
- `GET /api/workflows`: 200 legacy array, no envelope/source status/auth/tenant context.
- `GET /api/telemetry/consent`: 404, while `SettingsPage` calls it (`app/routes/SettingsPage.tsx:160`).

How to implement the fix:

- Add compatibility aliases for public contract endpoints or update the spec/client to the canonical route names.
- Move `/api/workflows` handling into `server/api/router.ts` or deprecate it in favor of `/api/orchestrator/*` and `/api/builder/workflows`.
- Add `GET /api/telemetry/consent` returning `{ consented, updatedAt }` or change `SettingsPage` to use an existing persisted settings endpoint.
- Add a route-contract smoke test for every endpoint in the documented public API list.

### 16E. Trace Explorer is a span table, not the promised trace analysis tool

What the plan claimed:

> "Successful AI work can be traced to jobs, articles, tool calls, outputs, and conclusions." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1990`)

What actually exists:

- `TracePage` renders date buttons, a span table, and a JSON attribute detail (`app/routes/TracePage.tsx:94`, `app/routes/TracePage.tsx:182`, `app/routes/TracePage.tsx:76`).
- Trace persistence is JSONL spans on disk (`server/tracing/exporter.ts:14`), with no normalized token, cost, article, dossier, job, or gateway-call attribution model.
- There is no flame graph, critical path view, token attribution, cost-per-trace, or trace-to-output lineage.

How to implement the fix:

- Extend spans with token/cost/gateway call IDs and entity links to jobs, articles, dossiers, builder runs, and artifacts.
- Add a trace summary endpoint that aggregates critical path duration, per-model latency, tokens, estimated cost, errors, and outputs.
- Replace the table-only UI with a timeline/flame graph plus attribution panels.

## P2 — Incomplete UX

### 17. Fetch hooks hide HTTP failures and cause silent empty/loading states

What the plan claimed:

> "Inline 401/403 surfaces for protected APIs." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:1681`)

What actually exists:

- `useApi` parses JSON without checking `response.ok` (`app/hooks/useApi.ts:34`).
- `useAuthApi` has the same issue (`app/hooks/useAuthApi.ts:34`).
- `authFetch` retries 401 with an auth modal but does not convert non-OK statuses into structured UI errors (`app/lib/authFetch.ts:23`).

Playwright found:

- Several pages showed loading forever or generic empties while underlying APIs were 403/404: `/governance`, `/litellm`, `/scout`, `/cost`, `/settings`, `/finance-intel`, `/projects`.

How to implement the fix:

- Standardize a `fetchJson` helper that throws `{status, error, detail, path}` for all non-OK responses.
- Update `useApi`, `useAuthApi`, and `useAuthenticatedApi` to share it.
- Add page-level `ErrorState` with retry, source path, and required permission.

### 18. Empty states do not distinguish healthy-empty from broken/degraded

What the plan claimed:

> "If source missing: explicit degraded badge, not blank card." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:516`)

What actually exists:

- `PriorityDeck` says `No immediate priorities / Everything looks good!` with no source coverage explanation (`app/components/PriorityDeck.tsx:89`).
- Compliance empty CSV says only `No data` (`server/api/reports.ts:161`).
- Workload empty state says `no workload data in selected time range` (`app/components/WorkloadGraphTable.tsx:132`).
- Gateway says `No circuits active` without source or policy explanation.

Playwright found:

- Empty or vague states on `/gateway`, `/workflows`, `/paperclip`, `/gemini`, `/claude`, and `/marketplace`.

How to implement the fix:

- Add a shared `SourceAwareEmptyState` component with `sourceStatus`, last successful read, expected data source, and next action.
- Require every API envelope to include source status per data source, not just page-level generated time.

### 19. Navigation remains overloaded and does not match the target operator IA

What the plan claimed:

> "Hide under Advanced until real: Marketplace, Compliance, Governance, Gateway, Projects, Workflows, Traces, Setup, About." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:97`)

What actually exists:

- `DashSidebar` still renders all core and advanced nav entries in the top-level sidebar (`app/components/DashSidebar.tsx:185`).
- `app/lib/navRegistry.ts` marks some advanced/labs pages, but that status does not remove them from the main product path (`app/lib/navRegistry.ts:15`).
- `/cost` is missing from the readiness registry and defaults to labs (`app/lib/navRegistry.ts:48`).

Playwright found:

- Every requested sidebar route was reachable, including advanced/labs pages. Several of those pages were broken or empty.

How to implement the fix:

- Split navigation into `targetNav`, `advancedNav`, and `labsNav`.
- Add an explicit Advanced section or Settings toggle.
- Keep `/about` and diagnostics reachable but out of the primary workflow.

### 20. Pagination, filtering, and large-table contracts are incomplete

What the plan claimed:

> "Every table: empty/loading/error, source freshness, pagination, searchable filter." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:404`)

What actually exists:

- Workload reads fixed limits and filters client-side (`server/api/workload.ts:46`, `app/components/WorkloadGraphTable.tsx:42`).
- Jobs/audit/traces render large fixed sets; several APIs use hard-coded `LIMIT 100` style patterns.
- Report output is rendered entirely in client state.

Playwright found:

- `/jobs`, `/audit`, `/traces`, `/builder`, and `/models` render data-heavy tables, but the audit did not find robust cursor/page affordances across them.

How to implement the fix:

- Add cursor pagination contracts to jobs, audit, traces, workload, gateway ledger, builder runs, and reports.
- Standardize table props for `cursor`, `nextCursor`, `sort`, `filters`, `sourceStatus`, and `exportUrl`.

### 21. Safe action design is inconsistent

What the plan claimed:

> "All destructive actions require: expected duration, impact, rollback, audit event." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:489`)

What actually exists:

- Some backend actions are protected and audited through `server/api/actions.ts`, but many page actions are direct modals or native confirms.
- Infra restart copy is minimal and not tied to dependency or incident data (`app/routes/InfraPage.tsx:56`).
- Agent and Builder destructive operations still use native confirms.

Playwright found:

- The live route audit did not click destructive actions, but code search confirms native dialogs and incomplete action metadata.

How to implement the fix:

- Create one `ActionPreflightModal` component.
- Require backend action descriptors from a registry with `risk`, `duration`, `blastRadius`, `rollback`, `auditKind`, and `permission`.
- Remove every `confirm()`, `prompt()`, and `alert()` call from `app/`.

### 22. SSE connection cap and health visibility do not match the plan

What the plan claimed:

> "SSE connection bound ... expose SSE stats." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:5664`)

What actually exists:

- `server/api/router.ts` caps SSE at 100 (`server/api/router.ts:292`).
- Duplicate unused SSE constants still exist in `server/index.ts:198`.
- No visible `/api/health/sse-stats` route was found in `server/api/router.ts`.

Playwright found:

- No direct page failure, but this remains an operational observability gap.

How to implement the fix:

- Move SSE cap config to one module.
- Add `GET /api/health/sse-stats`.
- Surface SSE/client connection health on `/doctor` or `/infra`.

### 22A. Channels is DB-backed, but notification rule editing is still operator-hostile

What the plan claimed:

> "Settings gets an Alert Rules page with templates, channel preferences, suppression list, and Telegram rate-limit state." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:2077`)

> "Notification preferences can set categories to in-app only, Telegram only, both, or disabled where allowed." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:2859`)

What actually exists:

- Channel log and notification rules are real DB-backed endpoints: `GET /api/channels` and `GET/POST /api/notifications/rules` are wired (`server/api/router.ts:410`, `server/api/router.ts:414`, `server/api/router.ts:568`).
- The UI edits rule kind as free text, threshold as raw JSON, and channels as CSV (`app/routes/ChannelsPage.tsx:354`, `app/routes/ChannelsPage.tsx:384`, `app/routes/ChannelsPage.tsx:398`).
- Brief actions are Telegram-specific shell-script executions (`server/api/channels.ts:179`, `server/api/channels.ts:212`).
- No Slack provider, channel health matrix, quiet hours, escalation UI, suppression list, or Telegram rate-limit state was found.

Live/API check:

- `GET /api/channels`: 200 with one log entry.
- `GET /api/notifications/rules?limit=5`: 200 with rule data.
- `POST /api/notifications/rules`: 200 and writes a rule, confirming this is partial rather than missing.

How to implement the fix:

- Keep the current DB-backed rule endpoints, but add typed alert templates and a visual condition builder.
- Add provider registry tables for Telegram and any future Slack/provider integrations.
- Replace CSV/JSON controls with channel multi-selects, condition-specific inputs, quiet-hours controls, and rate-limit preview.
- Add delivery health and last-error fields to the Channels page.

## P3 — Nice-to-Have / Polish

### 23. Visual language and component consistency need a finishing pass

What the plan claimed:

> "A dashboard that looks complete is not the same as a dashboard that is operationally complete." (`CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:25`)

What actually exists:

- UI uses a mixture of bespoke panels, inline styles, repeated table shells, and page-specific loading/error text.
- Several labs pages use generic "Loading..." and "No X found" copy.

Playwright found:

- Screenshots show inconsistent density and status treatment across `/today`, `/builder`, `/gateway`, `/models`, `/paperclip`, `/channels`, `/cost`, and `/settings`.

How to implement the fix:

- Create a shared page scaffold with title, source freshness, degraded source banner, primary actions, and help/runbook links.
- Consolidate table, metric card, empty state, and status badge styles.

### 24. Future plan surface is far larger than the implemented product

What the plan claimed:

The plan contains future sections for scheduled task automation, alerts, logs, deploys, backups, network map, dependency graph, model evals, risk events, brainstormer, AI validation, enterprise reporting, and audit-grade evidence.

What actually exists:

- Core DB schema has useful operational tables, but lacks many future tables: `scheduled_tasks`, `alerts`, `log_entries`, `deploy_events`, `backup_events`, `dependency_edges`, `risk_events`, `risk_notables`, `ai_runs`, `ai_spans`, `tool_calls`, `evidence_items`, and `report_artifacts`.

Playwright found:

- Labs and advanced pages expose some of this ambition, but the live UI often shows empty/loading states rather than finished workflows.

How to implement the fix:

- Split the current plan into:
  - committed product baseline;
  - active V4 scope;
  - future enterprise backlog.
- Do not mark future product families as done until schema, API, UI, action, and audit contracts are all present.

## Appendix: Playwright Findings

Script: `/tmp/cs-audit.mjs`

Report: `/tmp/cs-audit-report.json`

Screenshots: `/tmp/cs-audit-screenshots/`

| Route | Title captured | Screenshot | Findings |
| --- | --- | --- | --- |
| `/` | Operations | `/tmp/cs-audit-screenshots/home.png` | No API 404s. Visible pipeline error text and empty new-model state. |
| `/today` | Operations | `/tmp/cs-audit-screenshots/today.png` | Visible `FAILED`; `loading priorities...`; `loading workload data...`. |
| `/builder` | Builder | `/tmp/cs-audit-screenshots/builder.png` | Real data: workflows, runs, artifacts, projects. Many failed rows visible. |
| `/traces` | Traces | `/tmp/cs-audit-screenshots/traces.png` | Real rows. Active nav is `More`; error text appears from trace data. |
| `/gateway` | Gateway | `/tmp/cs-audit-screenshots/gateway.png` | Real status/ledger subdata. Empty `No circuits active` without source explanation. |
| `/opencode` | OpenCode | `/tmp/cs-audit-screenshots/opencode.png` | No API errors found. Uses raw session/control surface style. |
| `/codex` | Codex | `/tmp/cs-audit-screenshots/codex.png` | No API errors found. Live session content visible; error text from session content. |
| `/claude` | Claude | `/tmp/cs-audit-screenshots/claude.png` | Shows Anthropic credits exhausted and `no sessions yet`. |
| `/gemini` | Gemini | `/tmp/cs-audit-screenshots/gemini.png` | Shows `no sessions yet`. |
| `/models` | Models | `/tmp/cs-audit-screenshots/models.png` | Real inventory rows. Missing routed routing/cooldown controls. |
| `/litellm` | LiteLLM | `/tmp/cs-audit-screenshots/litellm.png` | 404s for `/api/litellm/status`, `/routing`, `/config`; visible `HTTP 404`; stuck loading. |
| `/jobs` | Jobs | `/tmp/cs-audit-screenshots/jobs.png` | Real rows. Needs cursor pagination/source freshness. |
| `/audit` | Audit | `/tmp/cs-audit-screenshots/audit.png` | Real rows. Needs richer audit drilldowns and report links. |
| `/compliance` | Compliance | `/tmp/cs-audit-screenshots/compliance.png` | Stuck `Loading templates...`; reports are not durable/full contract. |
| `/governance` | Governance | `/tmp/cs-audit-screenshots/governance.png` | 403 for `/api/governance/secrets`; browser cookie not honored for governance role. |
| `/workflows` | Workflows | `/tmp/cs-audit-screenshots/workflows.png` | Empty `No workflow instances yet`; no lifecycle/product guidance. |
| `/projects` | Projects | `/tmp/cs-audit-screenshots/projects.png` | 400 for `/api/projects`; visible loading. |
| `/marketplace` | Marketplace | `/tmp/cs-audit-screenshots/marketplace.png` | Visible loading/empty labs surface. |
| `/scout` | Scout | `/tmp/cs-audit-screenshots/scout.png` | 404 for `/api/scout/runs`; visible loading. |
| `/doctor` | Doctor | `/tmp/cs-audit-screenshots/doctor.png` | No API 404s; visible loading text during audit window. |
| `/autopipeline` | Pipeline | `/tmp/cs-audit-screenshots/autopipeline.png` | No API 404s; visible loading text during audit window. |
| `/newsbites` | NewsBites | `/tmp/cs-audit-screenshots/newsbites.png` | No API 404s; visible loading text during audit window. |
| `/infra` | Infra | `/tmp/cs-audit-screenshots/infra.png` | No API 404s; visible loading text; coverage incomplete. |
| `/incidents` | Incidents | `/tmp/cs-audit-screenshots/incidents.png` | No API 404s; visible loading text; lifecycle incomplete. |
| `/paperclip` | Paperclip | `/tmp/cs-audit-screenshots/paperclip.png` | Shows failed state and empty adapters/agents/tasks. |
| `/channels` | Channels | `/tmp/cs-audit-screenshots/channels.png` | Visible loading text; one entry returned by API smoke. |
| `/cost` | Cost | `/tmp/cs-audit-screenshots/cost.png` | Visible loading; page calls missing `/api/cost/summary`; API smoke `/api/cost` 404. |
| `/finance-intel` | Finance Intel | `/tmp/cs-audit-screenshots/finance-intel.png` | Visible loading; handlers not wired in router. |
| `/settings` | Settings | `/tmp/cs-audit-screenshots/settings.png` | Visible loading; system config endpoints not routed/persistent. |
| `/about` | About | `/tmp/cs-audit-screenshots/about.png` | Visible loading text; should be moved out of primary nav. |

## Appendix: API Smoke Test Results

Auth header used: `x-operator-token: Brighton13`

Base URL: `http://localhost:3000`

| Endpoint | Status | Result | Gap |
| --- | ---: | --- | --- |
| `/api/workload` | 200 | Envelope with `generatedAt`, `sourceStatus`, `data`; 225 entries. | Real data exists, but contract lacks graph edges/evidence/pagination. |
| `/api/today` | 200 | Envelope with Today data and 3 suggested schedule items. | Contains hard-coded/synthetic fields and disabled actions. |
| `/api/builder/workflows` | 200 | Envelope with 58 workflows. | Builder is one of the stronger real areas. |
| `/api/gateway` | 404 | `{"error":"not found"}` | Contract alias missing; only subroutes exist. |
| `/api/traces` | 200 | Envelope with 3 date groups. | Real data exists; needs richer drilldowns/pagination. |
| `/api/governance/audit` | 404 | `{"error":"not found"}` | Governance audit endpoint missing. |
| `/api/channels` | 200 | Envelope with 1 entry. | Real data exists; UX stays loading in Playwright sample. |
| `/api/builder/doctor/reports` | 404 | `{"error":"not found"}` | Route mismatch; actual route is `/api/builder/doctor-reports`. |
| `/api/cost` | 404 | `{"error":"not found"}` | Cost summary endpoint missing. |

## Appendix: Completed-Checkbox Audit

| Plan checkbox | Plan location | Audit result |
| --- | --- | --- |
| `Fix readBuilderDoctorReports() ... WHERE AND` | `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:5741` | Done. `server/builder/store.ts:746` strips leading `AND`; `server/builder/store.ts:748` conditionally adds `WHERE`. |
| `Fix builderArtifactContentHandler() ... tenanted run dirs` | `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:5742` | Done. `server/api/builder.ts:123` through `server/api/builder.ts:156` searches multiple artifact locations. |
| Zero-typing checklist | `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:4341` | Not done in product. Native dialogs remain and many raw text/path inputs remain. |
| Sample Brainstormer plan checkboxes | `CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md:3260` and nearby | Documentation examples only; no corresponding completed product surface found. |

## Appendix: False-Positive [x] Audit — Items Claimed Done But Not Implemented

Literal checkbox scan command: `rg -n "\\[[xX]\\]" CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md`

The plan contains 18 literal `[x]` lines. No literal `[x]` checkboxes were found in the Brainstormer API surface, report-template task list, Finance Intel section, Cost section, Scout section, Projects section, Marketplace section, or Compliance section. Those named areas are prose specs rather than checked completion items; their implementation gaps are captured in the P0/P1/P2 findings above.

| Plan location | [x] claim | What actually exists | Verdict |
|---|---|---|---|
| line:3260 | "Confirm service is running at [port] before starting." | Template text inside Section 37's generated Brainstormer plan example. No `/brainstorm` route in `app/App.tsx`, no Brainstormer nav item in `app/components/DashSidebar.tsx`, and `GET /api/brainstorm/sessions` returns 404. | STUB |
| line:3261 | "Check disk has > 2GB free." | Template text only. Disk telemetry exists elsewhere in sampler code, but no Brainstormer preflight/checklist implementation exists and no generated-plan preflight runner was found. | STUB |
| line:3262 | "Check no active Builder runs target this project." | Template text only. Builder locks exist (`server/db/dashboard.ts:373`, `server/db/dashboard.ts:382`), but the Brainstormer-generated checklist and `/api/builder/detected-plans` handoff are missing; `GET /api/builder/detected-plans` returns 404. | STUB |
| line:3263 | "Read [specific file] to understand current implementation." | Template placeholder only. No Brainstormer research phase or file-reading workflow exists in UI/API. | STUB |
| line:3275 | "[Specific subtask with file + line reference]" | Placeholder inside the generated-plan template, not a real implemented subtask. No code object or route corresponds to it. | STUB |
| line:3298 | "[Specific, measurable outcome]" | Placeholder inside the generated-plan template, not a real acceptance result. No implementation evidence. | STUB |
| line:4341 | "No text field where a dropdown, picker, or autocomplete is possible." | Violated in many reachable forms: Settings model fields (`app/routes/SettingsPage.tsx:457`, `app/routes/SettingsPage.tsx:498`), Channels rule kind/CSV fields (`app/routes/ChannelsPage.tsx:354`, `app/routes/ChannelsPage.tsx:398`), Marketplace bundle path (`app/routes/MarketplacePage.tsx:197`), Projects repo path (`app/routes/ProjectsPage.tsx:184`). | MISSING |
| line:4342 | "No raw cron expression where a human-readable scheduler is possible." | Builder exposes `Custom cron expression...` and a raw cron input (`app/routes/BuilderPage.tsx:627`, `app/routes/BuilderPage.tsx:629`). | MISSING |
| line:4343 | "No raw filesystem path where a file browser is possible." | `FileBrowser` exists (`app/components/FileBrowser.tsx:39`), but `/api/fs/browse` is not routed, and raw path fields remain in Builder, Marketplace, Projects, and Settings (`app/routes/BuilderPage.tsx:1991`, `app/routes/MarketplacePage.tsx:197`, `app/routes/ProjectsPage.tsx:184`, `app/routes/SettingsPage.tsx:176`). | PARTIAL |
| line:4344 | "No raw service name where a service picker is possible." | Infra service rows are discovered, but there is no reusable service picker for settings/actions. Static service identifiers remain in Settings fallback workspace data (`app/routes/SettingsPage.tsx:111`) and safe-action flows are not normalized around a picker. | PARTIAL |
| line:4345 | "No raw model ID where a logical model name picker is possible." | Settings uses raw text for model override and pipeline-stage model (`app/routes/SettingsPage.tsx:457`, `app/routes/SettingsPage.tsx:498`). `RoutingInspector` also uses model text inputs (`app/components/RoutingInspector.tsx:32`, `app/components/RoutingInspector.tsx:132`). | MISSING |
| line:4346 | "No unexplained input (every field has a tooltip or inline description)." | Many inputs have only labels/placeholders and no tooltip/explanation: Settings model/timeout fields (`app/routes/SettingsPage.tsx:457`, `app/routes/SettingsPage.tsx:467`), Channels threshold JSON (`app/routes/ChannelsPage.tsx:384`), Marketplace manifest JSON (`app/routes/MarketplacePage.tsx:206`). | MISSING |
| line:4347 | "No required input without a sensible default." | Some defaults exist, but required workflow/project/compliance inputs still lack sensible system-derived defaults: Builder project name/root (`app/routes/BuilderPage.tsx:1962`, `app/routes/BuilderPage.tsx:1966`), Compliance customer name (`app/routes/CompliancePage.tsx:438`), Channels new rule kind (`app/routes/ChannelsPage.tsx:435`). | PARTIAL |
| line:4348 | "No form that requires knowledge of the underlying system to fill out correctly." | Several forms require system internals: cron syntax (`app/routes/BuilderPage.tsx:629`), threshold JSON and channels CSV (`app/routes/ChannelsPage.tsx:384`, `app/routes/ChannelsPage.tsx:398`), manifest JSON (`app/routes/MarketplacePage.tsx:206`), model IDs (`app/routes/SettingsPage.tsx:498`). | MISSING |
| line:4349 | "No form that can be submitted with values that would obviously fail (validate before submit)." | Some validation exists, e.g. Channels parses threshold JSON (`app/routes/ChannelsPage.tsx:186`) and Marketplace validates manifests server-side. But Settings update is not routed and `server/api/systemConfig.ts` only logs and echoes changes with a TODO instead of persistence/validation (`server/api/systemConfig.ts:89`, `server/api/systemConfig.ts:92`). | PARTIAL |
| line:4350 | "No submit button labeled \"Submit\" — use the action name (\"Start Workflow\", \"Add to Pipeline\", \"Generate Report\")." | No exact generic `Submit` button label was found. The closest is `Submit Decision`, which names the action context (`app/routes/GovernancePage.tsx:230`). | OK |
| line:5741 | "Fix `readBuilderDoctorReports()` in `server/builder/store.ts` (~line 740): `conditions` array gets empty string pushed when `tenantWhere.clause` is empty (mimule tenant), causing `WHERE AND ...` SQL syntax error. Fix: add guard `const clauseStr = tenantWhere.clause.trim().replace(/^ AND /, \"\"); if (clauseStr) conditions.push(clauseStr);` and change the WHERE append to only fire when `conditions.length > 0`. Verify by running `bun run typecheck` and checking journalctl no longer shows `SQLiteError: near \"AND\": syntax error`." | Implemented. `server/builder/store.ts:746` strips leading `AND`; `server/builder/store.ts:748` only appends `WHERE` when `conditions.length > 0`. `bun run typecheck` passed. | OK |
| line:5742 | "Fix `builderArtifactContentHandler()` in `server/api/builder.ts` (~line 115): log files are looked up at flat path `/var/lib/control-surface/builder-runs/${runId}/pass-X-stderr.log` but tenant-aware runs are stored at `/var/lib/control-surface/tenants/{tenantId}/projects/{projectId}/builder-runs/${runId}/`. Fix: after the flat path `existsSync` check fails, compute the tenanted path using `getCurrentTenantContext()` and the project root from the run record (query `builder_runs` table for the run's `project_id`, then look up `builder_projects` for its `root`, then build the tenanted path as `CONTROL_SURFACE_DATA_DIR/tenants/${tenantId}/projects/${projectId}/builder-runs/${runId}/`). Verify by calling `GET /api/builder/log?runId=<recent-run-id>&kind=stderr&pass=1` and confirming it returns log content (not 404)." | Implemented. Handler checks flat path, DB tenant/project path, and run-directory fallback (`server/api/builder.ts:123`, `server/api/builder.ts:137`, `server/api/builder.ts:144`). Live check against recent run `br_20995dbc-7955-4e64-8531-10768f784f27` returned HTTP 200 and log content. | OK |

Summary:

- Total `[x]` items checked: 18
- Genuinely complete: 3 (16.7%)
- Partial/stub: 10 (55.6%)
- Completely missing: 5 (27.8%)

Breakdown:

- Template placeholders in Section 37: 6 checked boxes, all STUB.
- Zero-typing quality gate: 10 checked boxes; 1 OK, 4 PARTIAL, 5 MISSING.
- Concrete Builder bug fixes: 2 checked boxes, both OK.

## Appendix: Third-Pass Verification — Newly Found Gaps

### API Surface Results (Pass C)

Auth header used: `x-operator-token: Brighton13`

Base URL: `http://localhost:3000`

| Endpoint | HTTP Status | Real data? | Gap plan covered? |
|---|---:|---|---|
| `/api/jobs` | 200 | Yes: DB-backed jobs envelope, very large row set. | Covered: pagination/entity contract. |
| `/api/infra` | 200 | Partial: live host/systemctl/docker/Vast probes, but fixed service/container lists. | Covered, with a narrower note that Docker is probed but not fully inventoried. |
| `/api/incidents` | 200 | Partial: derived from pipeline alerts and Doctor abandons, not lifecycle incidents. | Covered. |
| `/api/doctor` | 200 | Yes: Doctor log/stats adapter, not static fixture. | Covered only as incomplete Doctor 2.0 depth. |
| `/api/traces` | 200 | Yes: trace date list from JSONL files. | Newly covered by item 16E. |
| `/api/workload` | 200 | Partial: jobs + builder runs + current pipeline, no graph edges/artifacts. | Covered. |
| `/api/models` | 200 | Partial: real model-health file, but cooldowns/discovery are empty fixtures. | Covered. |
| `/api/projects` | 400 | No usable page contract: requires tenant query. | Reclassified by item 5A. |
| `/api/workflows` | 200 | Legacy separate SQLite table, not current Workflows page/orchestrator contract. | Newly covered by item 16D. |
| `/api/marketplace/bundles` | 404 | No; implemented route is `/api/marketplace/skills`. | Newly covered by item 16D. |
| `/api/compliance/summary` | 200 | Partial: tenant settings plus static compliance docs/counts. | Covered. |
| `/api/governance/policies` | 200 | Partial: loads default policy path and DB decision count. | Covered. |
| `/api/settings` | 404 | No; settings are split/missing. | Newly covered by item 16D; related Settings gap already covered. |
| `/api/channels` | 200 | Yes: DB-backed channel log. | Covered. |
| `/api/scout/runs` | 404 | No; handler exists but is not routed. | Covered. |
| `/api/litellm/status` | 404 | No; handler exists but is not routed. | Covered. |
| `/api/finance-intel/stats` | 404 | No; handler exists but is not routed. | Covered. |
| `/api/brainstorm/sessions` | 404 | No handler/route found. | Covered. |
| `/api/autopipeline/queue` | 404 | No; queue is embedded in `/api/autopipeline`. | Newly covered by item 16D. |
| `/api/newsbites/articles` | 404 | No; articles are embedded in `/api/newsbites`. | Newly covered by item 16D. |
| `/api/builder/doctor-reports` | 200 | Yes: routed builder reports endpoint. | Covered as completed bug-fix area. |
| `/api/reports` | 404 | No root report center; only templates/run/detail/csv are routed. | Newly covered by item 16C. |
| `/api/cost/summary` | 404 | No. | Covered. |
| `/api/cost/spend` | 200 | Partial: real query shape, empty/null totals in current DB. | Covered. |

For 404s, handler-file check:

- Existing but not routed: `server/api/scout.ts`, `server/api/litellm.ts`, `server/api/financeIntel.ts`, `server/api/dossier.ts`, `server/api/systemConfig.ts`.
- Existing aggregate handler but missing subroute: `server/api/autopipeline.ts` for `/queue`, `server/api/newsbites.ts` for `/articles`, `server/api/reports.ts` for root `/api/reports`.
- No handler found: `/api/brainstorm/*`, `/api/marketplace/bundles`, `/api/cost/summary`.

### Component Data Wiring (Pass D)

| Component | Hardcoded data? | File:line of fixture | Gap plan covered? |
|---|---|---|---|
| `app/routes/TodayPage.tsx` | Partial. Page data comes from `/api/today`, while priorities come from `PriorityDeck`/`/api/mission-control`; action buttons are disabled. | `app/routes/TodayPage.tsx:260`; `app/components/PriorityDeck.tsx:66` limits to 3. | Covered. |
| `app/routes/InfraPage.tsx` | Partial. UI consumes `/api/infra`; backend probes a hardcoded service/container inventory. | `server/adapters/system.ts:8`; `server/adapters/system.ts:18`. | Covered, but Docker is probed for a fixed list. |
| `app/routes/DoctorPage.tsx` | No static fixture found. Uses `/api/doctor` log/stats data. | `app/routes/DoctorPage.tsx:23`; `server/api/doctor.ts:19`. | Mostly covered as product-depth gap. |
| `app/routes/IncidentsPage.tsx` | No local fixture, but uses reasoner incidents instead of `/api/incidents`. | `app/routes/IncidentsPage.tsx:228`. | Covered. |
| `app/routes/JobsPage.tsx` | No static fixture found. Uses `/api/jobs`. | `app/routes/JobsPage.tsx:51`. | Covered for pagination/entity contract. |
| `app/routes/TracePage.tsx` | No static fixture, but table-only span view. | `app/routes/TracePage.tsx:94`; `app/routes/TracePage.tsx:182`. | Newly covered by item 16E. |
| `app/routes/ModelsPage.tsx` | UI consumes `/api/models`; backend hardcodes empty cooldown/discovery arrays. | `server/api/models.ts:103`; `server/api/models.ts:106`. | Covered. |
| `app/routes/MarketplacePage.tsx` | Partial real DB list; install/run controls require raw path/JSON. Contract uses `/skills`, not requested `/bundles`. | `app/routes/MarketplacePage.tsx:56`; `app/routes/MarketplacePage.tsx:197`; `app/routes/MarketplacePage.tsx:206`. | Newly covered by item 16D; raw controls already covered. |
| `app/routes/AboutPage.tsx` | Partial. Version/runtime are live; install paths are hardcoded packaging values. | `app/routes/AboutPage.tsx:116`; `app/routes/AboutPage.tsx:120`; `app/routes/AboutPage.tsx:124`. | Newly noted in this appendix only; low severity. |
| `app/components/WorkloadGraphTable.tsx` | No static fixture; uses `/api/workload`, then client-filters a table. | `app/components/WorkloadGraphTable.tsx:17`; `app/components/WorkloadGraphTable.tsx:24`. | Covered. |

### Spec Sections With No Gap Plan Coverage (Pass A)

- Section 10 / Reports: already covered for trust/artifacts, but third pass found the concrete template catalog mismatch: 5 audit templates exist while the 8 required operator reports do not. Added item 16C.
- Autopipeline dossier inspector: existing plan covered missing `/api/dossier` route; third pass found a second UI bug where queue IDs are misused as dossier dates. Added item 5B.
- NewsBites and Autopipeline subresource APIs: existing plan covered broad production/pipeline incompleteness, but not the missing public `/api/newsbites/articles` and `/api/autopipeline/queue` endpoints. Added item 16D.
- Marketplace: existing plan covered raw bundle install UX, but not the `/api/marketplace/bundles` vs `/api/marketplace/skills` contract mismatch. Added item 16D.
- Workflows: existing plan covered empty/lifecycle UX, but not that `/api/workflows` is a legacy `server/index.ts` route backed by a separate `data/workflows.db` unrelated to the Workflows page. Added item 16D.
- Trace Explorer: existing plan said traces need richer drilldowns, but did not explicitly cover missing flame graph, token attribution, cost-per-trace, and trace-to-output lineage. Added item 16E.
- Settings: existing plan covered missing `/api/system-config`; third pass found `GET /api/telemetry/consent` is also missing and contributes to page loading failure. Added item 16D.

### Severity Re-classifications (Pass B)

- P0 item 1, unwired API modules: root cause confirmed. No false alarm.
- P0 item 2, public API contract drift: root cause confirmed and expanded by Pass C.
- P0 item 3, governance cookie/RBAC mismatch: root cause confirmed in code; header-auth works, cookie role lookup still ignores cookie.
- P0 item 4, reports/compliance trust: root cause confirmed.
- P0 item 5, cost page broken: root cause confirmed.
- P1 item 16, Projects: reclassify page breakage to P0 because live `GET /api/projects` returns 400 for the page/API smoke path. Added item 5A.
- P1 item 10, Infra: narrow but do not reclassify. Docker containers are probed for a hardcoded list in `server/adapters/system.ts`; the missing part is dynamic inventory, separate container UI, public URL/Caddy/Cloudflare/backup coverage.

### Newly Found Gaps Not In Gap Plan

New severity items were added above:

- P0 5A: Projects page breakage is P0, not only incomplete CRUD.
- P0 5B: Autopipeline dossier inspector has a second page-breaking route bug.
- P1 16C: Report catalog is missing the required operator report types.
- P1 16D: Public API contract drifts from implemented internal routes.
- P1 16E: Trace Explorer is a span table, not the promised trace analysis tool.


<!-- Builder run br_3e001: failed at 2026-05-18T10:12:14.250Z — details: /opt/ai-vault/builder/2026-05-18-bw_b3f8c-br_3e001.md -->