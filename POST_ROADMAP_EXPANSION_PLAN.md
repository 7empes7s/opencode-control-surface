# Post-Roadmap Expansion Plan (12 Months)

This document extends `AGENT_FRIENDLY_6_MONTH_PLAN.md` and defines what to build **after** the initial 6-month roadmap is complete.

Audience:
- Operators and product owners
- Coding agents (Gemma/Minmax) implementing roadmap slices
- Engineers defining reusable blocks and app templates

---

## 1) Vision for the next 12 months

Turn the Control App into a modular **Autonomy Platform**:
- `Core` = auth, policies, orchestration, routing, audit, metrics, jobs
- `Blocks` = reusable capabilities (ingest, evaluate, transform, publish, remediate)
- `Apps` = packaged workflows assembled from blocks

Outcome:
- Faster launch of new autonomous projects
- Better reliability and explainability
- Strong governance and cost control

---

## 2) Platform architecture evolution

## 2.1 Core layers

1. **Experience Layer**
   - Dashboards, app pages, control widgets, approvals, incident views
2. **Workflow Layer**
   - Pipeline templates, schedulers, runbooks, job orchestration
3. **Intelligence Layer**
   - Model routing, quality evaluation, anomaly detection, recommendations
4. **Data Layer**
   - Events, metrics, audits, jobs, memory index, policy snapshots
5. **Governance Layer**
   - RBAC/ABAC, policy engine, secret controls, compliance exports

## 2.2 New service modules (proposed)

- `server/platform/blocks/`
- `server/platform/apps/`
- `server/policy/`
- `server/copilot/`
- `server/memory/`
- `server/integrations/`
- `server/simulation/`

---

## 3) New apps to build (post-6-month roadmap)

## App A — Signal Graph Studio

Purpose:
- Build relationships between entities/topics/events from multi-source signals.

Key capabilities:
- Entity extraction and linking
- Trend acceleration detection
- Contradiction detection
- “What changed since yesterday?” summaries

Data contracts:
- Input: feeds, docs, events, incidents
- Output: graph nodes/edges + confidence + novelty score

Dependencies:
- Memory index
- Event schema standardization
- Quality evaluator block

---

## App B — Experiment Lab

Purpose:
- Continuous optimization of prompts, routing policies, and model fallback chains.

Key capabilities:
- A/B/C experiments
- Evaluation harness (quality/cost/latency)
- Promotion decision assistant

Data contracts:
- Input: task definitions + variants
- Output: comparative scores + recommendation

Dependencies:
- Router simulator
- Quality scoring module
- Cost intelligence metrics

---

## App C — Runbook Builder

Purpose:
- Visual/no-code operational automations from event triggers.

Key capabilities:
- Trigger-condition-action canvas
- Human approval gates
- Rollback branches and dry-run mode

Data contracts:
- Input: events/metric triggers
- Output: execution traces and action outcomes

Dependencies:
- Policy engine
- Action execution framework
- Audit + job subsystem

---

## App D — Publishing Ops

Purpose:
- Multi-channel distribution orchestration with feedback loops.

Key capabilities:
- Channel-specific transforms
- Compliance and style checks
- Post-publish performance ingestion

Dependencies:
- Content pipelines
- Integration adapters
- Analytics rollups

---

## App E — Intelligence Briefing

Purpose:
- High-signal daily/weekly briefings for operators and executives.

Key capabilities:
- Risk and opportunity ranking
- Confidence-backed recommendations
- “Ask follow-up” panel linked to evidence

Dependencies:
- Copilot feed
- Memory retrieval
- Explainability APIs

---

## 4) Reusable block catalog (for this app and external flows)

## 4.1 Ingestion blocks
- Feed Ingestor Block
- API Poller Block
- File Drop Block
- Webhook Collector Block

## 4.2 Transformation blocks
- Cleaner/Normalizer Block
- Deduplication Block
- Entity Extraction Block
- Summarization Block

## 4.3 Intelligence blocks
- Router Decision Block
- Quality Judge Block
- Contradiction Checker Block
- Novelty Detector Block

## 4.4 Control blocks
- Approval Gate Block
- Action Runner Block
- Retry/Fallback Block
- Rollback Block

## 4.5 Governance blocks
- Policy Evaluator Block
- RBAC Guard Block
- Redaction Block
- Compliance Export Block

## 4.6 Output blocks
- Dashboard Publisher Block
- Slack/Discord/Email Publisher Block
- CMS/Web Publisher Block
- Ticket/Issue Creator Block

---

## 5) Block interface spec (agent-friendly)

Each block must implement:

```ts
interface Block<Input, Output> {
  id: string;
  version: string;
  kind: string;
  validateInput(input: unknown): asserts input is Input;
  execute(ctx: BlockContext, input: Input): Promise<BlockResult<Output>>;
}

interface BlockContext {
  correlationId: string;
  runId: string;
  actor: { id: string; role: string };
  nowIso: string;
  flags: Record<string, boolean>;
}

interface BlockResult<T> {
  ok: boolean;
  output?: T;
  error?: { code: string; message: string; retriable: boolean };
  metrics?: Record<string, number>;
  audit?: Record<string, unknown>;
}
```

Requirements:
- deterministic error codes
- structured audit payloads
- PII/secret redaction before persistence

---

## 6) External “attachable flows” ideas

1. **Customer Voice Intelligence Flow**
   - Support tickets + social mentions + feature requests -> prioritized themes
2. **Security Drift Flow**
   - Config drift, dependency changes, suspicious events -> risk digest
3. **Developer Productivity Flow**
   - PR/test/deploy trends -> blockers and throughput suggestions
4. **Partner Monitoring Flow**
   - Vendor status pages, SLA alerts, API health -> fallback readiness
5. **Market Research Flow**
   - Competitor releases/pricing/docs -> strategic briefings
6. **Knowledge Freshness Flow**
   - Detect stale docs/runbooks and propose updates

---

## 7) 12-month phase schedule (after month 6)

## Phase 7 (Months 7-8): Platformization
- Build Block SDK and registry
- Implement 8 core blocks
- Launch Runbook Builder alpha

## Phase 8 (Months 9-10): App expansion
- Ship Signal Graph Studio + Experiment Lab beta
- Add Publishing Ops connectors
- Introduce cross-app orchestration

## Phase 9 (Months 11-12): Enterprise hardening
- Full governance suite (RBAC/ABAC/compliance exports)
- Scenario simulator GA
- Executive briefing mode

---

## 8) Agent-friendly delivery strategy

For every app/block:
1. PR1: contracts + types + tests
2. PR2: server implementation + unit tests
3. PR3: UI integration + state handling
4. PR4: observability + audit + docs
5. PR5: hardening + rollback + migration notes

PR size rules:
- max ~500 LOC net change preferred
- 1 migration per PR max
- feature flags for nontrivial behavior

---

## 9) KPI framework for expansion stage

North-star KPIs:
- Time to launch a new app template
- Cost per successful autonomous run
- Incident MTTR and recurrence rate
- Operator intervention rate
- Recommendation acceptance rate

Per-app KPIs:
- Signal Graph: novelty precision, contradiction recall
- Experiment Lab: quality gain per cost delta
- Runbook Builder: auto-remediation success rate
- Publishing Ops: publish cycle time and engagement lift
- Briefing: time saved and decision confidence

---

## 10) Risks and safeguards

Top risks:
1. Over-complexity across many apps
2. Policy drift and unsafe automation
3. Quality regressions from model changes
4. Hidden cost growth from experiments
5. Integration brittleness

Safeguards:
- feature flags and staged rollouts
- strict policy gates + approval chains
- canary + evaluation harnesses
- spend guardrails and alerts
- contract tests for integrations

---

## 11) Immediate backlog seeds (next 3 sprints)

Sprint seed A:
- Block SDK skeleton
- Block registry API
- first 3 blocks (Normalizer, Approval Gate, Action Runner)

Sprint seed B:
- Runbook Builder alpha UI
- execution DAG backend
- dry-run mode and trace viewer

Sprint seed C:
- Experiment Lab MVP
- router simulation dashboard
- baseline benchmark suite

---

## 12) Suggested companion docs

- `BLOCK_SDK_SPEC.md`
- `APP_TEMPLATE_GUIDE.md`
- `POLICY_ENGINE_RULEBOOK.md`
- `INTEGRATIONS_PLAYBOOK.md`
- `SRE_OPERATIONS_MANUAL.md`

