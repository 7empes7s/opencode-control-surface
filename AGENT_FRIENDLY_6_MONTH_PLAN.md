# Control Surface — 6-Month Agent-Friendly Implementation Plan

This plan is optimized for coding agents (Gemma, Minmax, etc.) and humans working together.

---

## 0) How to use this plan (agent workflow contract)

### Execution rules for coding agents
- Work in **small PRs** (1 feature slice each).
- Each PR must include:
  - code changes
  - tests
  - migration notes (if DB/API changed)
  - rollback notes
- Never merge a feature without:
  - typecheck passing
  - lint passing
  - relevant unit/integration tests passing
- Keep feature flags for all risky/new behavior.

### Definition of done for every task
1. API contract updated and documented.
2. UI state/error/loading behavior implemented.
3. Audit/event logging added.
4. Tests added/updated.
5. Observability counters/events emitted.
6. Security review checklist completed.

### Suggested branch naming
- `feat/<area>-<short-name>`
- `fix/<area>-<short-name>`
- `chore/<area>-<short-name>`

---

## 1) Target outcomes by end of Month 6

- Control app acts as a **mission-control system** for pipelines, models, and agent workflows.
- High-signal observability with traceable actions/jobs/events.
- Intelligent model routing (cost/latency/quality aware).
- Doctor-guided remediation with safe automation tiers.
- Multi-project orchestration templates running concurrently.
- Strong operator UX, approvals, and governance.

---

## 2) Month-by-month roadmap (with weekly breakdown)

## Month 1 — Foundations, reliability, and observability

### Month objectives
- Normalize telemetry and event vocabulary.
- Make actions/jobs fully traceable with correlation IDs.
- Baseline reliability dashboards and SLOs.

### Week 1
- **Schema + contracts**
  - Add/standardize event schema (`event_type`, `severity`, `component`, `run_id`, `correlation_id`).
  - Add shared TypeScript types for event payloads.
- **Tasks**
  - Create `server/observability/types.ts`.
  - Refactor existing event emits in API handlers to use shared type helpers.
  - Add strict runtime validators for inbound/outbound event payloads.
- **Deliverables**
  - Unified event type definitions.
  - Test fixtures for all event categories.

### Week 2
- **Traceability**
  - Add correlation ID generation and propagation UI -> API -> DB.
  - Add `X-Correlation-Id` support in `authFetch` and API handlers.
- **Tasks**
  - Add middleware helper in `server/api/*` to get/set correlation ID.
  - Persist correlation IDs in action audit and jobs tables.
- **Deliverables**
  - Correlation ID visible in UI audit details and logs.

### Week 3
- **SLO dashboard v1**
  - Build panels: queue lag, job success rate, failed actions by type, stream disconnects.
- **Tasks**
  - Add rollup query endpoints (`/api/metrics` extensions).
  - Implement dashboard widgets in `TodayPage` or `MissionControl` section.
- **Deliverables**
  - First SLO summary cards + trend charts.

### Week 4
- **Hardening and gap closure**
  - Backfill missing audit writes for mutating endpoints.
  - Add error fingerprinting and top-failure leaderboard.
- **Deliverables**
  - Incident-ready observability baseline.
  - Runbook doc for reading SLO failures.

---

## Month 2 — Intelligent model routing and cost control

### Month objectives
- Convert model rotation into policy-based routing.
- Add fallback graph and canary routing.
- Track quality/cost/latency outcomes.

### Week 1
- **Router policy engine v1**
  - Define routing inputs: task type, urgency, budget, model health, doctor status.
- **Tasks**
  - Create `server/routing/policy.ts` + `server/routing/engine.ts`.
  - Add route simulation endpoint (`/api/models/simulate-route`).

### Week 2
- **Fallback graph execution**
  - Implement deterministic fallback graph with reason codes.
- **Tasks**
  - Add fallback chain configs in `config/model-routing.json`.
  - Persist every fallback transition to metrics/audit.

### Week 3
- **Quality scoring**
  - Add quality evaluator pipeline (rule checks + model judge).
- **Tasks**
  - Create `server/eval/quality.ts`.
  - Add `quality_score` storage to relevant DB tables.

### Week 4
- **Canary + budget controls**
  - 5-10% traffic canary for candidate models.
  - Soft/hard spend limits with operator alerts.
- **Deliverables**
  - Router v1 active behind feature flag.

---

## Month 3 — Doctor 2.0 and self-healing automation

### Month objectives
- Expand doctor from status checks to diagnosis and guided remediation.
- Introduce safe automation tiers.

### Week 1
- **Doctor runbook schema**
  - Declarative runbook format (`symptom`, `checks`, `actions`, `confidence`).
- **Tasks**
  - Add `server/doctor/runbooks/*.json`.
  - Add runbook evaluator service.

### Week 2
- **Recommendation engine**
  - Show ranked remedies in Doctor page.
- **Tasks**
  - Add `/api/doctor/recommendations` endpoint.
  - Display confidence and blast-radius tags.

### Week 3
- **Automation tiers**
  - Tier 0: suggest only; Tier 1: auto low-risk; Tier 2: approval required.
- **Tasks**
  - Add policy gate checks in execute path.
  - Add UI toggles and audit visibility.

### Week 4
- **Post-incident assistant**
  - Auto-generate timelines and likely root-cause hypotheses.
- **Deliverables**
  - MTTR-focused doctor toolkit.

---

## Month 4 — Multi-project orchestration and templates

### Month objectives
- Support multiple pipeline types beyond current report flow.
- Add project registry + scheduler fairness.

### Week 1
- **Pipeline template SDK**
  - Standard template contract (stages, SLAs, quality gates, actions).
- **Tasks**
  - Add `server/pipelines/templates/` with schema and loader.

### Week 2
- **Project registry UI**
  - Create/clone/pause/archive project templates.
- **Tasks**
  - Add `/api/projects/*` endpoints.
  - Add Projects page with lifecycle actions.

### Week 3
- **Scheduler fairness**
  - Weighted fair scheduling by priority + deadlines + budget state.
- **Tasks**
  - Add scheduler module and observability traces.

### Week 4
- **Ship 3 templates**
  1) Research Radar
  2) Competitor Watchtower
  3) Ops Changelog Digest
- **Deliverables**
  - 3 production-like templates demonstrable in UI.

---

## Month 5 — Operator Copilot and memory layer

### Month objectives
- Provide proactive recommendations.
- Add historical/semantic memory over incidents and actions.

### Week 1
- **Copilot feed**
  - “What needs attention now?” ranked by urgency + impact.
- **Tasks**
  - Add `/api/copilot/brief` endpoint.
  - Add Copilot panel to home/today page.

### Week 2
- **Operational memory index**
  - Index incidents/jobs/audits for semantic retrieval.
- **Tasks**
  - Add `server/memory/indexer.ts` and query API.

### Week 3
- **Decision explainability**
  - Explain why model/action was selected/blocked.
- **Tasks**
  - Add explain endpoint to routing + action execution.

### Week 4
- **Feedback loops**
  - Capture operator edits/overrides and learn policy weights.
- **Deliverables**
  - Copilot v1 with explainability + memory search.

---

## Month 6 — Governance, integrations, and enterprise readiness

### Month objectives
- Security/governance hardening.
- External integrations and simulation capabilities.

### Week 1
- **RBAC + permission matrix**
  - Roles: Viewer, Operator, Admin, Automation.
- **Tasks**
  - Add permission checks to sensitive endpoints.
  - Add role-aware UI controls.

### Week 2
- **Approval workflow v2**
  - Multi-approver and policy-based approvals.
- **Tasks**
  - Extend action gating with approval chains.

### Week 3
- **Integrations framework**
  - Webhooks + Slack/Discord + GitHub issue hooks.
- **Tasks**
  - Add outbound event dispatcher and retry queue.

### Week 4
- **Simulation mode**
  - “What-if” scenario simulator for outages and load spikes.
- **Deliverables**
  - Governance-ready control platform.

---

## 3) Coding-agent issue template (copy/paste)

```md
Title: <feature slice>

Context
- Why this is needed
- Relevant existing modules

Scope
- In scope:
- Out of scope:

Implementation steps
1.
2.
3.

API/DB changes
- Endpoints:
- Migrations:
- Backward compatibility notes:

Tests
- Unit:
- Integration:
- Manual smoke checks:

Observability
- New metrics/events:
- Audit entries:

Rollback plan
- Toggle/flag:
- Revert steps:
```

---

## 4) Suggested epic list (execution order)

1. Observability Contract Unification
2. Correlation IDs + End-to-end Traceability
3. SLO Dashboard v1
4. Model Router v1 + Fallback Graph
5. Quality Scoring + Canary Routing
6. Doctor Runbook Engine + Remediation Tiers
7. Project Template SDK + Registry
8. Weighted Scheduler + Multi-project Fairness
9. Operator Copilot + Memory Search
10. RBAC + Approval Chains + Integrations + Simulation

---

## 5) Acceptance KPIs by month

- **M1**: >95% trace coverage for actions/jobs/events.
- **M2**: 20% lower cost per successful run at same or better quality score.
- **M3**: 30-40% reduction in MTTR for recurring incidents.
- **M4**: 3+ concurrent project templates running with stable throughput.
- **M5**: Copilot recommendations accepted by operator at meaningful rate (>25% initially).
- **M6**: RBAC + approvals + integrations stable in production-like environment.

---

## 6) Risk register and mitigations

1. **Scope creep from many features**
   - Mitigation: strict feature flags, small PR slices, monthly freeze week.
2. **Model quality variance**
   - Mitigation: quality scoring + canary + fallback reason telemetry.
3. **Operational safety risks**
   - Mitigation: approval gates, allowlists, role checks, audit-first design.
4. **UI complexity overload**
   - Mitigation: shared component primitives + UX consistency checklist.
5. **DB/migration instability**
   - Mitigation: migration tests, snapshot backups, rollback scripts.

---

## 7) Immediate next 10 tasks (start this week)

1. Add correlation ID helper utilities and tests.
2. Add unified event type module and migrate two endpoints first.
3. Add SLO cards for queue lag and failed actions.
4. Add audit enrichment with correlation IDs.
5. Define router policy config schema.
6. Implement simulation-only route selection endpoint.
7. Define doctor runbook JSON schema.
8. Add feature flag mechanism for routing and doctor automation.
9. Add action failure fingerprinting endpoint.
10. Write operator handbook page for interpreting SLO and incident data.

