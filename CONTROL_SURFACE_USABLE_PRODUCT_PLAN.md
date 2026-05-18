# Control Surface Usable Product Plan

Last updated: 2026-05-17 UTC
Scope: `/opt/opencode-control-surface`
Owner: Marouane Defili
Status: Proposed reset plan

## 1. Executive Summary

Dashboard V4 currently has the right ambition but the wrong center of gravity. The project expanded from a stack dashboard into a broad "autonomy platform" with enterprise-style pages, generic compliance/reporting concepts, and partially wired modules. That expansion added surface area, but it did not yet make the control surface more useful for the actual MIMULE / TechInsiderBytes stack.

The usable product should be:

- a daily operator cockpit for Marouane,
- a command surface for NewsBites production,
- a model/GPU/cost control room,
- an incident and remediation console,
- an agent workbench for Claude, Codex, Gemini, and OpenCode,
- a durable audit and report layer that explains what happened and what to do next.

Everything else is secondary. Generic platformization, marketplace, enterprise compliance, tenant sales packaging, and public installer flows should be hidden or deferred until the core stack experience is valuable every day.

## 2. Current Diagnosis

### 2.1 What Works

- The app builds and typechecks as of 2026-05-17:
  - `bun run typecheck`: passed.
  - `bun run build`: passed, with the known single large JS chunk warning.
- The live service is healthy:
  - `GET /health` returns `{"ok":true,"version":"0.8.0"}`.
- V4 foundations exist:
  - SQLite-backed events, metrics, jobs, audits, samplers, and action descriptors.
  - Pages for home, today, pipeline, doctor, models, NewsBites, infra, incidents, agents, builder, audit, and jobs.
  - Some safe action execution already exists for pipeline, models, NewsBites deploy, infra restart, timers, and Builder runs.
  - Agent pages are moving toward parity across Claude, Codex, Gemini, and OpenCode.

### 2.2 What Is Not Usable Enough

- The roadmap is too generic. `POST_ROADMAP_EXPANSION_PLAN.md` describes a broad autonomy platform, but it does not explain the operator workflows that matter for this stack.
- The reports are shallow. Current report templates are mostly audit-table queries and do not answer operational questions like "what story is blocked?", "which model is hurting output?", "what should I publish next?", or "what did the agents change today?".
- Several new sections are product shells. Projects, Workflows, Governance, Gateway, Compliance, Marketplace, Setup, and About have pieces of functionality, but many do not yet provide a complete MIMULE-specific workflow.
- The navigation is overloaded. There are roughly two dozen top-level routes. A usable product should not ask the operator to choose between many half-finished pages.
- UI style is inconsistent. There is a mix of dashboard design-system classes, Tailwind utilities, inline styles, modal variants, table styles, and enterprise-SaaS copy. The result feels generated instead of operated.
- Actionability is incomplete. Many rows and reports show data but do not provide the nearest safe action, impact preview, evidence, failure path, and audit record.
- Auth and permissions are inconsistent across new areas. Some pages use `authFetch`, others use raw `fetch`; some endpoints rely on token checks, some rely on role checks, and some fail into poor UI states.
- The product vocabulary drifted. "TIB Builder", "tenants", "licenses", "SOC2", "marketplace", and "cloud tier" may be future packaging ideas, but they distract from the immediate personal media-company control room.

## 3. Product Principle Reset

Every page must pass this test:

> If Marouane opens this from a phone at 07:00 UTC, can he understand what matters, take a safe next action, and trust the evidence?

If a page does not pass, it should be hidden from primary navigation until it does.

### Required Entity Contract

Every reported object must include:

- status,
- freshness,
- evidence,
- impact,
- primary action,
- secondary actions,
- risk level,
- expected duration,
- rollback or fallback path,
- audit trail.

This applies to:

- services,
- timers,
- Docker containers,
- GPU/Vast,
- LiteLLM models and providers,
- autopipeline queue items,
- dossiers,
- articles,
- Paperclip agents,
- Mimule/OpenClaw session state,
- Builder workflows,
- Codex/Claude/Gemini/OpenCode sessions,
- jobs,
- incidents,
- reports.

## 4. Target Product Shape

### 4.1 Primary Navigation

Replace the current broad nav with a smaller operational nav:

1. Today
2. Production
3. Pipeline
4. Models
5. Infra
6. Agents
7. Builder
8. Reports
9. Incidents
10. Audit
11. Settings

Hide from primary nav until productized:

- Marketplace
- Compliance
- Governance
- Gateway
- Projects
- Workflows
- Traces
- Setup
- About

These can remain as `/labs/*` or "Advanced" routes, but they should not compete with core operations.

### 4.2 Core Pages

#### Today

Purpose: the first screen for daily operations.

Must show:

- top 5 priorities ranked by urgency and business impact,
- NewsBites production state,
- pipeline queue and approval state,
- model/GPU health,
- service incidents,
- latest agent work,
- pending decisions,
- recent publishes,
- "safe actions available now".

Primary actions:

- resume pipeline,
- approve/reject pending publish,
- open stuck dossier,
- rerun model health check,
- switch a model policy,
- restart a failed service,
- create an agent task,
- generate morning brief,
- log session to AI Vault.

Acceptance criteria:

- A useful operator can decide what to do next within 30 seconds.
- Every priority card has evidence and an action.
- Empty states explain exactly what data source is missing.

#### Production

Purpose: run the media company, not just inspect the site.

Must show:

- article backlog,
- approved/published/draft counts by vertical,
- today's publish cadence,
- story freshness,
- source quality,
- dossier status,
- publish blockers,
- panels/frontmatter health,
- recent NewsBites deploys.

Primary actions:

- open article file,
- open dossier folder,
- publish approved dossier,
- send story back to write/research/verify,
- add topic to autopipeline with vertical/priority,
- redeploy site,
- validate frontmatter,
- create panel follow-up.

Reports from this page:

- daily editorial output,
- blocked dossiers,
- vertical balance,
- source quality gaps,
- publish failures.

#### Pipeline

Purpose: control Autopipeline and Paperclip work.

Must show:

- queue depth and oldest item age,
- current stage,
- waiting approvals,
- paused/running state,
- GPU/cloud split,
- recent stage durations,
- failed stage clusters,
- Paperclip agent health if available.

Primary actions:

- pause/resume,
- add topic with full vertical/priority/source options,
- rush item,
- kill item,
- retry failed item,
- inject dossier at a selected stage,
- batch approve low-risk publish-prep items,
- open dossier evidence,
- create incident from stuck item.

Acceptance criteria:

- No row ends with only passive text.
- Queue and approval rows expose exact commands/API calls used.
- Stage timing is historical, not only a current snapshot.

#### Models

Purpose: know which models are usable, expensive, degraded, rate-limited, or worth routing to.

Must show:

- logical model names from LiteLLM,
- backend/provider,
- latest health check result,
- latency,
- quality status,
- rate-limit/quota events,
- cooldowns,
- usage/cost estimate,
- GPU availability,
- Vast runway,
- routing recommendation.

Primary actions:

- run model-health-check,
- block/unblock model,
- clear probation,
- simulate routing,
- promote/demote provider,
- restart Vast tunnel,
- run Vast reconcile,
- open LiteLLM config evidence,
- create model incident.

Reports:

- model reliability report,
- cost report,
- rate-limit report,
- routing-change recommendation.

#### Infra

Purpose: operate the VPS safely.

Must show:

- systemd services,
- Docker containers,
- timers,
- disk/RAM/CPU,
- Cloudflare tunnel,
- Caddy status,
- backups,
- Vast tunnel,
- ports and public URLs.

Primary actions:

- restart allowlisted service/container,
- run timer,
- view logs,
- verify backup,
- run backup now,
- open runbook,
- create incident,
- check public health.

Acceptance criteria:

- Restart actions show blast radius and rollback hint.
- Backup section includes last successful backup and verification state.
- Disk projection creates an actionable warning.

#### Agents

Purpose: one cockpit for Claude, Codex, Gemini, and OpenCode.

Must show:

- sessions,
- active runs,
- auth/health state,
- model/profile/effort controls,
- permissions/sandbox mode,
- skills and commands,
- MCP resources,
- workspace roots,
- transcript controls,
- handoff to Builder,
- vault logging.

Primary actions:

- start session,
- continue/resume,
- stop,
- delete,
- select workspace,
- select model/profile,
- attach file/image where supported,
- run skill,
- create Builder workflow from conversation,
- log to AI Vault,
- create continuation packet.

Acceptance criteria:

- All agent pages share the same layout and control grammar.
- Unsupported features render disabled with evidence, not missing.
- No native `confirm()` or `prompt()` dialogs remain.

#### Builder

Purpose: make agent work repeatable and validated, not just run one-off chat sessions.

Must show:

- registered stack projects,
- workflow templates,
- current runs,
- pass logs,
- validations,
- artifacts,
- plan progress,
- source-session handoff context,
- project locks.

Primary actions:

- bootstrap new project,
- create workflow,
- start/stop/pause/resume workflow,
- retry failed run,
- open changed files,
- run validation,
- trigger doctor review,
- clean stale lock,
- log result.

Acceptance criteria:

- A workflow can run end-to-end against one real stack project.
- The result is understandable without reading raw logs.
- Project locks have clear owner, age, and release path.

#### Reports

Purpose: answer real operator questions with evidence and action links.

The current compliance report templates should be replaced or moved under Audit. Reports should be stack-specific and useful.

Required reports:

1. Daily Operator Brief
   - priorities,
   - published stories,
   - stuck items,
   - service health,
   - model health,
   - money/risk notes,
   - recommended actions.

2. Editorial Production Report
   - articles by status and vertical,
   - source coverage,
   - failed publishes,
   - stale drafts,
   - under-served verticals,
   - pipeline-to-publish conversion.

3. Pipeline Queue Report
   - queue age,
   - stage distribution,
   - stuck approvals,
   - failed stages,
   - agent/model responsible,
   - suggested cleanup actions.

4. Model Reliability and Cost Report
   - provider/model usage,
   - errors,
   - cooldowns,
   - average latency,
   - estimated cost,
   - quality status,
   - routing recommendations.

5. Infrastructure Reliability Report
   - service uptime transitions,
   - restarts,
   - failed probes,
   - backup status,
   - disk growth,
   - external URL checks.

6. Agent Work Report
   - active sessions,
   - Builder runs,
   - files touched,
   - validations run,
   - failed checks,
   - handoffs created,
   - unlogged work.

7. Incidents and Remediation Report
   - open incidents,
   - resolved incidents,
   - root-cause hypothesis,
   - actions taken,
   - unresolved follow-ups.

8. Audit Export
   - action audit,
   - secrets access,
   - approval events,
   - report run history,
   - hash-chain status.

Each report must include:

- summary,
- key findings,
- rows,
- evidence links,
- recommended actions,
- export JSON/CSV/Markdown,
- schedule option,
- "send to Telegram" option if low risk.

#### Incidents

Purpose: manage lifecycle, not just list anomalies.

Must show:

- open incidents,
- severity,
- owner,
- source event,
- impacted stack area,
- timeline,
- related jobs/actions,
- suggested remediation,
- resolution state.

Primary actions:

- acknowledge,
- assign owner,
- run suggested check,
- create job,
- mute duplicate,
- resolve with note,
- generate postmortem.

#### Audit

Purpose: durable operational memory.

Must show:

- action audit,
- job history,
- report runs,
- operator decisions,
- secrets access,
- approvals,
- session logs,
- hash-chain verification.

Primary actions:

- export,
- verify chain,
- filter by entity,
- open linked job/entity,
- create follow-up task.

#### Settings

Purpose: configure this private stack.

Must show:

- operator auth status,
- endpoints and paths,
- watched services,
- protected actions,
- model-routing preferences,
- notification preferences,
- Telegram/Mimule bridge status,
- AI Vault logging preferences.

No generic public SaaS onboarding should live here until packaging is real.

## 5. All-Page Product Audit

Checked visually on 2026-05-17 against the live service at `127.0.0.1:3000`. The visual pass captured 66 screenshots across desktop, tablet, and iPhone 16 Pro before the all-route script was stopped. The partial mobile pass is still enough to show the main product problems.

### 5.1 Global Mobile Findings

- The top shell is too tall for fast phone use. Brand, icons, stack pill, theme toggles, tenant/project selectors, live badge, UTC time, and version consume too much vertical space before the route content.
- Many routes show both an "Operations" shell title and a route title, which creates duplicate hierarchy.
- The mobile bottom nav currently promotes Marketplace, but the intended primary item was OpenCode. This is a concrete nav bug.
- The More/hamburger patterns overlap conceptually. There should be one primary mobile navigation model.
- Most pages start with status information instead of conclusions and next actions.
- Text contrast is often too dim on mobile, especially body copy, table text, and disabled-looking but important values.
- Tables remain too wide or too dense. The phone experience needs entity cards and detail drawers, not desktop tables compressed into 393px.
- Primary actions are often far down the page or presented as unlabeled icon buttons.
- The mobile experience should be optimized for "check, decide, approve" in under a minute.

### 5.2 Route-by-Route Direction

| Route | Current Problem | Product Direction |
|---|---|---|
| `/` | Widget wall still reads as status display. | Convert to priority deck with AI conclusions and recommended next actions. |
| `/today` | Shows counts and event feed, but not enough interpretation. | Make it the daily brief: what changed, why it matters, what to do. |
| `/autopipeline` | Useful controls exist, but queue items need explanations, workload grouping, and batch decisions. | Turn into production queue command center. |
| `/doctor` | Too much raw diagnostic output; weak conclusion layer. | AI should explain errors, cluster symptoms, name likely causes, and propose remediations. |
| `/models` | Has health/action data, but does not explain routing choices or why a model is blocked/degraded. | Add AI-generated model recommendation, rate-limit explanation, workload fit, and routing simulation. |
| `/newsbites` | Good source data, but not a full production desk. | Add story readiness, stale dossiers, vertical balance, source quality, and publish actions. |
| `/infra` | Service actions exist but need better impact, logs, backup, and incident linkage. | Make it a safe ops runbook UI. |
| `/incidents` | Not enough lifecycle depth. | Add acknowledge, owner, timeline, cause, actions, resolution, and postmortem. |
| `/jobs` | Job list needs stronger source/entity links. | Every job should link to trigger, entity, logs, artifacts, and next action. |
| `/audit` | Useful but too audit-log oriented. | Add linked operational memory and report/action replay. |
| `/builder` | Strongest new product area, but mobile tables/actions are cramped and it still feels workflow-centric. | Make Builder an AI work system with project detection, validation, trace, and handoff summaries. |
| `/workflows` | Generic orchestrator surface; hard to know why it matters. | Either integrate into Builder or make it a traceable automation detail page. |
| `/marketplace` | Premature for private-stack value. | Move to labs until core product is usable. |
| `/traces` | Useful primitive but not enough context. | Merge traces into Governance, AI Calls, Runs, and Incident detail views. |
| `/gateway` | Important for AI calls, but currently usage/circuit data is too thin. | Make it the AI gateway control plane: calls, models, policies, costs, safety, failures. |
| `/governance` | Current tabs are too simple for the desired policy model. | Redesign around identity, data protection, AI safety, policy evaluation, and full run tracing. |
| `/compliance` | Too generic and partially disconnected. | Fold into Governance and Reports until enterprise packaging is real. |
| `/projects` | Manual project registry is underpowered. | Add AI-assisted "detect all projects" and project intelligence. |
| `/settings` | Should configure the private stack, not generic product settings. | Keep only operator-relevant stack/auth/notification/model settings. |
| `/about` | Branding and install paths drift toward packaged product. | Hide or simplify until packaging is real. |
| `/install` | Public onboarding is premature and some API calls do not match current handlers. | Move to labs; replace with private stack setup checklist later. |
| `/opencode` | Needs parity with other agent pages and mobile-first controls. | Shared agent cockpit layout. |
| `/codex` | Needs full trace/governance capture for runs and tools. | Shared agent cockpit layout plus run trace detail. |
| `/claude` | Needs same controls and trace visibility as Codex where available. | Shared agent cockpit layout plus run trace detail. |
| `/gemini` | Still has native confirm flows and different controls. | Bring to shared agent cockpit parity. |

## 6. AI-First Operator Assistance

AI should do most of the cognitive work, but not silently take high-risk actions. The dashboard should continuously explain, classify, prefill, and recommend.

### 6.1 AI Assistance Contract

Every major page should expose:

- `What happened?`
- `Why does it matter?`
- `What is likely causing it?`
- `What should I do next?`
- `What can the AI prepare for me?`
- `What is safe to run automatically?`
- `What needs explicit approval?`

### 6.2 Assistance Modes

1. Explain
   - AI summarizes errors, logs, queue states, model failures, incidents, and run outputs.

2. Detect
   - AI detects projects, workloads, stack roles, services, missing metadata, stale docs, and likely owners.

3. Prefill
   - AI fills project profiles, validator commands, runbook fields, report conclusions, incident summaries, and action reasons.

4. Recommend
   - AI suggests next actions, model routing changes, queue cleanup, report follow-ups, and remediation steps.

5. Prepare
   - AI drafts commands, PR/task descriptions, Builder workflows, Telegram summaries, and AI Vault entries.

6. Execute
   - Only low-risk allowlisted actions may auto-run.
   - Medium/high/destructive actions require preview, confirmation, reason, and audit.

### 6.3 Error Explanation

Every error display should include:

- plain-language explanation,
- likely cause,
- exact evidence,
- affected service/project/model/story,
- recommended fix,
- safe retry action if available,
- escalation path,
- "ask AI to investigate" action.

### 6.4 Smart Workload Detection

The dashboard should not require manual project setup for everything under the stack.

Add:

- `POST /api/projects/discover-all`
- `POST /api/projects/analyze`
- `POST /api/projects/:id/refresh-ai`
- `GET /api/projects/candidates`

### 6.5 Workload Graph Detection

The current detection model is not sufficient if it only surfaces NewsBites workloads or failures. The product needs a workload graph that captures all meaningful work, including successful work.

Detect and persist:

- successful jobs,
- failed jobs,
- running jobs,
- skipped jobs,
- blocked jobs,
- article generation work,
- dossier work,
- publish work,
- model health checks,
- agent sessions,
- Builder runs,
- tool-call batches,
- deploys,
- backup runs,
- governance/policy evaluations,
- report generations.

Every workload node should link to:

- workload id,
- status,
- start/end timestamps,
- source system,
- project,
- job id,
- article slug if any,
- dossier path if any,
- published URL if any,
- Builder workflow/run/pass if any,
- agent session if any,
- model/provider,
- trace id,
- tool calls,
- output artifacts,
- validation results,
- logs/evidence,
- AI conclusion,
- recommended follow-up.

Specific mapping requirements:

- NewsBites: queue item -> dossier -> stage runs -> draft/publish files -> article slug -> public URL.
- Autopipeline: command/job -> stage -> model/backend -> result -> approval/publish state.
- Builder: workflow -> run -> pass -> tool calls -> files changed -> validation -> final status.
- Agents: session -> messages -> tool calls -> files/network/actions -> AI Vault log.
- Models: health check -> provider/backend -> model -> status change -> routing recommendation.
- Infra: service/timer/container action -> job -> logs -> result -> incident if failed.

The UI must show successful work, not only errors. A daily operator should be able to answer:

- What completed successfully today?
- Which articles did that produce?
- Which jobs created or modified those articles?
- Which AI/model/tool calls were involved?
- What failed, and what succeeded after retry?
- What should be cleaned up or followed up?

Discovery should scan:

- `/opt/*`,
- `/root/*PLAN*.md`,
- systemd unit files,
- Docker compose files,
- Caddy/Cloudflare config where safe,
- package manifests,
- git remotes and status,
- known data roots under `/var/lib/*`,
- AI Vault daily logs,
- dashboard plans.

Discovery should ignore or mark as non-project:

- backups,
- node_modules,
- build outputs,
- caches,
- generated run directories unless linked to Builder,
- secrets and credential stores.

AI should infer:

- project name,
- business purpose,
- stack role,
- owner,
- primary URL,
- local port,
- service/container/timer names,
- repo path,
- language/framework,
- package manager,
- validator commands,
- deploy command,
- rollback path,
- risk level,
- related plans/docs,
- related reports,
- related dashboard page,
- suggested Builder workflow templates.

Acceptance:

- A "Detect All Projects" button produces a reviewable candidate list.
- AI-filled fields are labeled as inferred until accepted.
- The operator can accept, edit, reject, or merge candidates.
- Accepted projects become first-class entities in Builder, Reports, Incidents, Governance, and Settings.

## 7. Governance And Full AI Run Tracing

Governance should follow the structural completeness of Microsoft Entra ID, Purview, and Defender policy surfaces, adapted to a private AI-operated media stack.

### 7.1 Governance Areas

1. Identity and Access
   - SSO state,
   - MFA requirements,
   - conditional access,
   - role assignments,
   - session state,
   - operator token/session health,
   - service principals or automation identities.

2. Data Protection
   - sensitivity labels,
   - sensitive info detection,
   - DLP-like rules for prompts, outputs, logs, files, and exports,
   - retention policies,
   - redaction rules,
   - allowed storage locations.

3. AI Safety
   - prompt/output safety metrics,
   - tool-call risk scoring,
   - model/provider policy,
   - unsafe action detection,
   - hallucination/low-confidence markers,
   - source quality markers,
   - human approval requirements.

4. Network and Activity Logs
   - outbound AI provider calls,
   - local gateway calls,
   - tool calls that touch network,
   - webhook/API calls,
   - Cloudflare/Caddy/public checks,
   - unusual traffic or failed auth.

5. Policy Evaluation
   - policy definitions,
   - assignments,
   - scopes,
   - conditions,
   - controls,
   - exceptions,
   - evaluation results,
   - remediation,
   - history.

6. Evidence and Compliance
   - audit chain,
   - exports,
   - report history,
   - incident links,
   - job links,
   - run traces.

### 7.2 Policy Object Model

Policies should not be simple rows. Use a complete structure:

```ts
interface GovernancePolicy {
  id: string;
  name: string;
  category:
    | "identity"
    | "conditional-access"
    | "mfa"
    | "sso"
    | "data-protection"
    | "labeling"
    | "sensitive-info"
    | "network"
    | "ai-safety"
    | "model-routing"
    | "tool-access"
    | "retention"
    | "compliance";
  state: "report-only" | "enabled" | "disabled";
  severity: "info" | "low" | "medium" | "high" | "critical";
  description: string;
  scope: PolicyScope;
  assignments: PolicyAssignment[];
  conditions: PolicyCondition[];
  controls: PolicyControl[];
  exceptions: PolicyException[];
  evidenceSources: EvidenceRef[];
  lastEvaluation: PolicyEvaluationSummary | null;
  remediation: PolicyRemediation[];
  version: number;
  updatedAt: number;
  updatedBy: string;
}
```

### 7.3 Full AI Call And Run Trace

All AI calls and agent runs must be traceable, not only failures.

Capture:

- run id,
- parent session id,
- actor,
- tenant/project,
- source page,
- requested task,
- model logical name,
- resolved provider/model,
- gateway route,
- prompt messages,
- attachments,
- retrieved context,
- reasoning summary and provider reasoning output when explicitly available,
- tool calls,
- tool arguments after redaction,
- tool outputs after redaction,
- shell commands,
- file reads/writes,
- API/network calls,
- approvals requested,
- approvals granted/denied,
- policy decisions,
- labels applied,
- sensitive-info detections,
- safety scores,
- token counts,
- latency,
- cost estimate,
- output text/artifacts,
- validation results,
- final conclusion,
- follow-up recommendations.

Important constraint:

- The system must not invent hidden chain-of-thought. Store model-visible reasoning summaries, explicit reasoning outputs when the provider exposes them, and structured conclusions. If hidden reasoning is not available, store "reasoning not exposed by provider" plus the observable evidence.

### 7.4 AI Run Detail Page

Every run should have a detail page with tabs:

- Overview
- Timeline
- Messages
- Reasoning Summary
- Tool Calls
- Files
- Network
- Policies
- Safety
- Cost/Latency
- Outputs
- Validations
- Follow-ups

The operator should be able to answer:

- What did the AI try to do?
- What did it see?
- What tools did it call?
- What changed?
- What did it conclude?
- Was any sensitive data involved?
- Which policies fired?
- What should happen next?

### 7.5 AI Safety Metrics

Track at minimum:

- prompt sensitivity score,
- output sensitivity score,
- policy risk score,
- tool risk score,
- destructive-action attempts,
- approval bypass attempts,
- blocked tool calls,
- provider error class,
- model confidence marker where available,
- source coverage,
- citation/evidence completeness,
- hallucination-risk heuristic,
- retry count,
- human override count.

### 7.6 Microsoft-Style Policy UX

Each policy page should have:

- Overview,
- Assignments,
- Conditions,
- Controls,
- Exclusions,
- Report-only results,
- Enforced results,
- Affected runs/users/projects,
- Recommendations,
- Change history,
- Export.

Policy examples:

- Require approval for live-service restart from mobile.
- Require MFA/strong session before destructive actions.
- Block secrets in prompts to external models unless labeled safe.
- Label NewsBites unpublished drafts as internal.
- Detect API keys/secrets in AI outputs and tool logs.
- Prevent publishing if source coverage is below threshold.
- Block model route when provider is in cooldown or quality is degraded.
- Require human approval for actions touching `/etc`, `/var/lib`, systemd, Docker, Caddy, Cloudflare, or production content.
- Flag network calls to unknown domains from agent tools.
- Require AI Vault log for completed Builder runs.

### 7.7 Enterprise Governance Reference Model

Take product inspiration from the strongest patterns in leading governance, compliance, security, and AI observability platforms:

- Microsoft Entra: conditional access as an if-then policy system with assignments, conditions, grant controls, session controls, report-only mode, and enforced mode.
- Microsoft Purview: discover, classify, label, protect, detect sensitive information, apply DLP controls, retain evidence, and explain policy matches.
- Microsoft Defender XDR: correlate alerts, assets, investigations, and evidence into incidents; provide guided investigation and "go hunt" actions.
- Splunk Enterprise Security: collect low-level events, convert them into risk events, aggregate risk against entities, and create high-fidelity notables when thresholds are crossed.
- ServiceNow GRC: model authority documents, policies, controls, indicators, owners, evidence tasks, exceptions, and remediation workflows.
- Vanta/Drata-style compliance automation: continuously collect evidence, map it to controls, show audit readiness, and generate downloadable evidence.
- AWS Security Hub / Google Security Command Center: standardize findings, controls, severity, compliance status, affected resources, risk scoring, and remediation guidance.
- NIST AI RMF and ISO/IEC 42001: govern, map, measure, and manage AI risk with documented policies, processes, controls, evaluations, monitoring, and continual improvement.
- Azure AI Foundry / OpenTelemetry agent tracing: trace AI calls, tool calls, quality, performance, safety, and cost using consistent spans and context propagation.

The goal is not to clone any one product. The goal is to combine their best patterns into a private, AI-first governance layer for the MIMULE / TechInsiderBytes stack.

### 7.8 Enterprise Modules

#### Governance Home

Must show:

- overall risk score,
- compliance readiness score,
- AI safety score,
- policy coverage,
- control health,
- evidence freshness,
- open exceptions,
- failed controls,
- high-risk runs,
- pending approvals,
- top recommendations.

Views:

- Executive summary,
- Operator view,
- Auditor view,
- Engineer view,
- Mobile quick check.

#### Authority Documents And Frameworks

Support a framework library:

- internal MIMULE controls,
- SOC 2-style trust principles,
- ISO 27001-style controls,
- ISO 42001-style AI management controls,
- NIST AI RMF functions,
- custom TechInsiderBytes editorial controls,
- custom AI-agent operation controls.

Each authority document should map to:

- policies,
- control objectives,
- control requirements,
- evidence sources,
- responsible owner,
- test method,
- frequency,
- latest result,
- exceptions,
- reports.

#### Policy Center

Policy center must support:

- policy templates,
- custom policy builder,
- report-only mode,
- simulation mode,
- enforced mode,
- version history,
- approvals for policy changes,
- rollback,
- assignment/scope,
- exceptions,
- evaluation history,
- remediation tasks.

Policy templates should include:

- Require approval for destructive tool calls.
- Require strong operator session for live-service actions.
- Block external model calls containing detected secrets.
- Require sensitivity labels for unpublished articles and dossiers.
- Require source coverage before publish.
- Require AI Vault log for completed agent work.
- Require trace retention for governance-relevant runs.
- Require incident creation for repeated model failures.
- Require backup verification after critical file changes.

#### Identity And Access

Add:

- operator identity,
- service/automation identities,
- SSO readiness,
- MFA policy,
- conditional access policy,
- session age,
- device/browser signal where available,
- mobile high-risk action policy,
- role and permission matrix,
- privileged action history.

The private stack can start with one operator, but the model must be enterprise-capable:

- Viewer,
- Operator,
- Engineer,
- Auditor,
- Admin,
- Automation.

#### Data Protection

Add Purview-style data governance:

- sensitivity labels,
- retention labels,
- sensitive info types,
- prompt/output/file scanners,
- redaction policies,
- DLP rules,
- export controls,
- allowed destinations,
- policy tips before action execution.

Built-in sensitivity labels:

- Public,
- Internal,
- Confidential,
- Secret,
- Credential,
- Unpublished Editorial,
- Source Material,
- Customer/Partner Data,
- Operational Control.

Sensitive info detectors:

- API keys,
- OAuth tokens,
- private keys,
- passwords,
- session cookies,
- emails,
- phone numbers,
- Telegram IDs,
- service URLs with credentials,
- database connection strings,
- unpublished article content,
- proprietary planning docs.

#### AI Governance

Add:

- model/provider inventory,
- approved model list,
- blocked model list,
- task-to-model policy,
- external/local routing policy,
- context-sharing policy,
- prompt safety,
- output safety,
- tool-call safety,
- hallucination-risk checks,
- source/evidence completeness,
- model quality drift,
- cost/budget controls.

Every AI run should have:

- trace,
- policy evaluations,
- safety metrics,
- cost,
- data labels,
- detected sensitive info,
- conclusion,
- follow-up actions.

#### Risk Engine

Add Splunk-style risk event aggregation:

- every weak signal becomes a risk event,
- risk events are attached to a risk object,
- risk objects include model, service, article, project, agent, operator session, provider, endpoint, dossier, and workflow,
- multiple low-risk events can aggregate into a high-risk notable,
- risk notables become incidents or recommendations.

Example risk aggregation:

- one failed model call is low risk,
- repeated failures plus rate-limit warnings plus blocked publish is a notable,
- notable opens an incident with recommended actions.

#### Incident And Investigation Center

Add Defender-style correlated incidents:

- alerts,
- affected assets/entities,
- evidence,
- related runs,
- related policies,
- timeline,
- investigation notes,
- AI-generated summary,
- "go hunt" query/actions,
- remediation playbooks,
- resolution,
- postmortem.

Go-hunt actions:

- find all runs involving this model,
- find all tool calls touching this file,
- find all prompts containing this sensitive type,
- find all articles affected by this failed stage,
- find all provider calls with this error class,
- find all actions from this mobile session.

#### Evidence And Audit Readiness

Add Vanta-style continuous evidence collection:

- evidence collectors,
- evidence freshness,
- controls mapped to evidence,
- missing evidence tasks,
- owner assignment,
- audit-ready evidence packages,
- scheduled evidence snapshots,
- automated report generation.

Evidence objects need:

- source,
- collector,
- collectedAt,
- control mapping,
- hash,
- retention policy,
- redaction status,
- download link,
- related run/job/action/report.

#### Control Indicators And Tasks

Add ServiceNow-style indicators:

- control test definitions,
- test frequency,
- threshold,
- owner,
- current result,
- previous result,
- status,
- work notes,
- remediation task,
- due date.

Examples:

- "AI run trace coverage >= 95% for last 7 days."
- "No secret detector critical hits unresolved."
- "All live-service restarts include reason and audit record."
- "All published articles have source coverage report."
- "All Builder runs have validation result and AI Vault log."

### 7.9 Easy For Anyone UX

Enterprise-level does not mean complex for the operator. The UX must progressively disclose complexity.

Modes:

- Quick Check: what matters and what to do.
- Guided Fix: AI explains issue and walks through remediation.
- Investigation: timeline, evidence, related entities.
- Audit: controls, evidence, report exports.
- Admin: policies, assignments, exceptions.

Every governance page should include:

- plain-language summary,
- risk score,
- "why this matters",
- recommended next action,
- evidence drawer,
- export/download,
- ask-AI investigation.

Every policy should have:

- template explanation,
- preview/simulation before enforcement,
- report-only mode,
- affected entities,
- false-positive handling,
- exception workflow,
- rollback.

### 7.10 Enterprise Architecture

Add these backend layers:

- Event lake: normalized append-only events from services, agents, models, reports, policies, and tools.
- Trace store: OpenTelemetry-style spans for AI calls, tool calls, jobs, workflows, and network calls.
- Entity graph: projects, services, models, articles, dossiers, runs, jobs, policies, controls, incidents, evidence.
- Policy engine: evaluates policies in report-only and enforced modes.
- Risk engine: aggregates risk events into notables.
- Evidence store: durable files, manifests, hashes, redaction metadata, downloads.
- Report engine: async generation, artifact storage, schedules, downloads.
- Recommendation engine: AI-generated explanations, conclusions, and next actions.
- Action engine: preview, approval, execution, rollback, audit.

Minimum schemas:

- `entities`
- `entity_links`
- `workloads`
- `ai_runs`
- `ai_spans`
- `tool_calls`
- `network_events`
- `policy_definitions`
- `policy_assignments`
- `policy_evaluations`
- `risk_events`
- `risk_notables`
- `control_definitions`
- `control_indicators`
- `evidence_items`
- `report_artifacts`
- `sensitive_detections`
- `labels`
- `exceptions`

### 7.11 Enterprise Maturity Levels

Level 1: Private Operator Console

- stack health,
- actions,
- audit,
- basic reports,
- AI explanations.

Level 2: Governed AI Operations

- full AI traces,
- policy evaluations,
- labels,
- sensitive-info detection,
- workload graph,
- downloadable reports.

Level 3: Audit-Ready Control Surface

- control library,
- evidence automation,
- report schedules,
- indicator tasks,
- exceptions,
- compliance packages.

Level 4: Enterprise Governance Platform

- SSO/MFA/Conditional Access,
- multi-role access,
- risk engine,
- incident investigation center,
- continuous monitoring,
- framework mapping.

Level 5: Easy Self-Service Product

- guided onboarding,
- AI setup assistant,
- project auto-discovery,
- policy templates,
- user-friendly explanations,
- auditor-ready exports,
- safe automation defaults.

## 8. Mobile-First Product Requirements

Mobile is the main fast-access experience, so design phone-first for the core routes.

### 8.1 Mobile Shell

Replace the current large mobile shell with:

- one compact top bar,
- stack health chip,
- current route title,
- one More menu,
- no duplicated "Operations" block on every route,
- no tenant/project block unless the route needs it,
- bottom nav with only the highest-value pages:
  - Today,
  - Pipeline,
  - Models,
  - NewsBites,
  - Agents,
  - More.

### 8.2 Mobile Page Pattern

Each core mobile page should start with:

1. conclusion,
2. top recommended action,
3. top risks,
4. latest evidence,
5. detail sections.

Not:

1. brand,
2. tenant,
3. project,
4. version,
5. raw table.

### 8.3 Mobile Interactions

- Action buttons must be full-width or obvious icon+label buttons.
- Long rows open a detail drawer.
- Tables become cards or compact summaries.
- Confirmation sheets use impact preview and risk.
- AI explanation should be one tap from every warning/error.
- Report summaries should be readable without opening CSVs.

## 9. Compliance And Downloadable Evidence Reports

Compliance cannot be a minimal page with static templates. It needs a real report generation system with downloadable evidence packages.

### 9.1 Compliance Report Lifecycle

Each compliance report must have:

- report template,
- parameters,
- source coverage check,
- generation job,
- progress state,
- completed/partial/failed status,
- generated summary,
- AI-written conclusions,
- evidence manifest,
- row-level data,
- download artifacts,
- verification hash,
- generation history,
- rerun action,
- schedule action,
- AI Vault log action.

Report statuses:

- `ready`
- `generating`
- `success`
- `partial`
- `failed`
- `expired`

If a report cannot be generated, the UI must explain:

- which source failed,
- what evidence is missing,
- whether the report is partial,
- what action can fix it.

### 9.2 Required Compliance Reports

1. AI Activity and Safety Report
   - all AI calls,
   - model/provider,
   - prompts/output metadata,
   - safety metrics,
   - blocked/approved actions,
   - sensitive-info detections,
   - tool-call risk.

2. Conditional Access and Session Report
   - operator sessions,
   - auth status,
   - SSO state,
   - MFA requirements,
   - risky session events,
   - mobile/live-service action approvals.

3. Sensitive Information and Labeling Report
   - labels applied,
   - sensitive info detected in prompts/outputs/files/logs,
   - redactions,
   - DLP-style policy decisions,
   - exceptions.

4. Network and Provider Activity Report
   - outbound AI provider calls,
   - local LiteLLM/gateway calls,
   - tool web requests,
   - unknown domains,
   - failures,
   - latency/cost.

5. Policy Evaluation Report
   - policies evaluated,
   - report-only hits,
   - enforced blocks,
   - exceptions,
   - affected runs,
   - recommended policy changes.

6. Run and Tool Trace Report
   - every run,
   - tool calls,
   - arguments after redaction,
   - outputs after redaction,
   - files touched,
   - commands,
   - final conclusions.

7. Editorial Compliance Report
   - article/dossier lineage,
   - source coverage,
   - vertical/category,
   - publish approval,
   - generated outputs,
   - human overrides.

8. Audit Chain and Retention Report
   - action audit hash-chain verification,
   - retention policy,
   - deleted/expired artifacts,
   - export history.

### 9.3 Download Formats

Each generated report should support:

- HTML view,
- Markdown,
- JSON,
- JSONL for raw rows,
- CSV for row tables,
- ZIP evidence bundle,
- optional PDF later if rendering is reliable.

Each ZIP evidence bundle should include:

- `REPORT.md`,
- `summary.json`,
- `findings.json`,
- `rows/*.jsonl`,
- `evidence-manifest.json`,
- `hashes.sha256`,
- redacted log excerpts,
- linked action/job/run ids.

### 9.4 Compliance UX

The Compliance page should become a report center:

- template catalog,
- parameter drawer,
- generate button,
- generation progress,
- report run history,
- download buttons,
- schedule controls,
- failed/partial source explanations,
- AI conclusions,
- evidence preview,
- policy links.

No report button should silently do nothing. No download button should appear before an artifact exists.

## 10. Report System Redesign

### 10.1 New Report Contract

Replace the current row-only report output with:

```ts
interface OperatorReport {
  id: string;
  templateId: string;
  title: string;
  generatedAt: number;
  period: { fromTs: number; toTs: number };
  status: "success" | "partial" | "failed";
  summary: string;
  findings: ReportFinding[];
  metrics: ReportMetric[];
  rows: ReportRow[];
  actions: ActionDescriptor[];
  evidence: EvidenceRef[];
  exports: {
    jsonUrl?: string;
    csvUrl?: string;
    markdownUrl?: string;
  };
  degradedSources: Array<{ source: string; reason: string }>;
}

interface ReportFinding {
  id: string;
  severity: "info" | "warn" | "critical";
  title: string;
  explanation: string;
  evidence: EvidenceRef[];
  actions: ActionDescriptor[];
}

interface ReportMetric {
  label: string;
  value: string | number;
  trend?: "up" | "down" | "flat" | "unknown";
  interpretation: string;
}
```

### 10.2 Required Data Sources

- NewsBites articles from `/opt/newsbites/content/articles`.
- NewsBites git/deploy state.
- Autopipeline API on `127.0.0.1:3200`.
- Dossier directories under the editorial pipeline.
- Paperclip container/API/database where available.
- LiteLLM config and model health JSON.
- `/var/lib/mimule/model-health.json`.
- `/var/lib/mimule/model-quality.json`.
- Vast tunnel and GPU health.
- systemd service state and journal excerpts.
- Docker container state.
- Cloudflare/Caddy/public URL probes.
- Dashboard SQLite events/jobs/audit/metrics.
- AI Vault daily logs.
- Agent session metadata.

### 10.3 Fix Current Report Gaps

- `gateway-calls` should query `gateway_calls`, not only `action_audit`.
- `chain-verifier` must verify the hash chain, not only check that `row_hash` exists.
- Reports UI must use `authFetch` and display 401/403 states inline.
- Report templates need parameter controls, not hardcoded tenant/time ranges.
- Report runs should be visible in a history table with rerun/export actions.
- Empty reports must explain whether there is no activity or the data source is disconnected.
- Compliance reports must generate durable downloadable artifacts, not only in-memory row data.
- Successful workloads must appear in reports and governance traces, not only errors.

## 11. Design System Reset

### 11.1 Visual Direction

The control surface should feel like a serious operator console for a private media company:

- dense but readable,
- calm,
- stack-specific,
- action-oriented,
- fast on mobile,
- no marketing hero sections,
- no enterprise filler copy,
- no generic SaaS onboarding unless packaging is active.

### 11.2 Component Rules

- Use one page shell: `dash-page`.
- Use one card primitive: `SectionCard`.
- Use one modal primitive: `ConfirmModal` or a shared modal component.
- Use one table primitive: sortable, responsive, evidence/action drawer support.
- Use one action menu primitive for row actions.
- Use one status pill system.
- Use one form field system.
- Use one drawer for evidence/action details.
- Remove native `alert`, `confirm`, and `prompt`.
- Remove ad hoc inline layout styles where a reusable class exists.

### 11.3 Mobile Rules

- The mobile top nav should expose only core pages plus More.
- Touch targets must be at least 44px.
- Wide tables need mobile-specific columns and row drawers.
- Modals must never exceed viewport width.
- Agent pages need wrapped topbars and compact transcript controls.
- Primary actions should remain reachable without horizontal scrolling.

### 11.4 Copy Rules

- Use MIMULE/TechInsiderBytes names and real stack concepts.
- Do not use vague copy like "enterprise readiness" unless it maps to a live need.
- Empty states should say:
  - what source was checked,
  - why it is empty,
  - what the operator can do next.

## 12. Implementation Roadmap

### Phase 0: Stop the Bleeding (2-3 days)

Goal: make the current product less confusing immediately.

Tasks:

- Move unready routes behind `/labs/*` or an Advanced menu.
- Fix `PRIMARY_NAV` so mobile does not show Marketplace where OpenCode was intended.
- Rename "TIB Builder" copy to "Control Surface" unless referring specifically to Builder.
- Add a visible "experimental" badge to Gateway, Governance, Compliance, Marketplace, Projects, Workflows, Traces, Setup, and About.
- Replace raw `fetch` with `authFetch` for protected UI actions.
- Add inline 401/403 handling instead of relying on `window.prompt`.
- Disable or hide report run buttons until authenticated.
- Add a nav/readiness registry so every route has `core`, `advanced`, `labs`, or `hidden` status.

Acceptance:

- Core nav contains only pages with real operator value.
- No hidden homepage fallbacks or confusing route aliases.
- Unauthenticated states are understandable.

### Phase 1: Today Becomes the Product (1 week)

Goal: make the first screen useful every morning.

Tasks:

- Build a `PriorityDeck` backed by real sources.
- Rank priorities by impact:
  - stuck pipeline approvals,
  - failed services,
  - GPU/Vast down,
  - low Vast runway,
  - high queue age,
  - model rate limits,
  - publish failures,
  - disk projection,
  - unlogged agent work.
- Add evidence/action drawer for each priority.
- Add "Morning Brief" report generation.
- Add "Send brief to Telegram" as a guarded action.

Acceptance:

- Today page answers "what needs my attention now?"
- Every priority has at least one direct next action.

### Phase 2: Real Reports (2 weeks)

Goal: replace shallow reports with stack-specific operational reports.

Tasks:

- Implement the new `OperatorReport` contract.
- Add templates:
  - Daily Operator Brief,
  - Editorial Production,
  - Pipeline Queue,
  - Model Reliability and Cost,
  - Infra Reliability,
  - Agent Work,
  - Incident Remediation,
  - Audit Export.
- Store report runs with output, degraded sources, and export URLs.
- Add Markdown export for AI Vault and Telegram.
- Add downloadable compliance evidence bundles.
- Add report history with rerun/export actions.
- Fix gateway and chain-verifier data correctness.
- Add successful-workload coverage so reports show what completed, not only what failed.

Acceptance:

- Reports are useful even when no rows exist.
- Reports include findings and recommended actions, not only CSV rows.

### Phase 3: Actionability Everywhere (2 weeks)

Goal: make every row actionable.

Tasks:

- Standardize `ActionDescriptor` generation server-side.
- Add an action/evidence drawer used by all core pages.
- Ensure all high-risk actions require confirmation and reason.
- Ensure every action writes audit, job, and source evidence where relevant.
- Add action result links back to source entity.
- Add failed-action-to-incident flow.
- Add workload graph links from actions/jobs/runs/articles/dossiers/traces.

Acceptance:

- No core table row or card ends in a dead end.
- Failed actions are traceable and recoverable.

### Phase 4: Production Desk (2 weeks)

Goal: make NewsBites operations first-class.

Tasks:

- Add Production page.
- Read article metadata, dossiers, source files, and publish state.
- Show stuck articles and stale drafts.
- Add add-topic form with vertical, priority, and source notes.
- Add dossier-stage inject action.
- Add publish/deploy actions with audit.
- Add content-health report.

Acceptance:

- Operator can go from "what should publish?" to "publish/retry/fix" inside the dashboard.

### Phase 5: Pipeline and Model Control (2 weeks)

Goal: make Autopipeline and model routing controllable.

Tasks:

- Improve Pipeline table with stage age, source dossier, model used, failure cluster, and direct actions.
- Add batch approval guardrails.
- Add stage duration history and stuck-stage alerts.
- Add model routing simulation.
- Add rate-limit/quota detector UI.
- Add provider/model recommendation cards.
- Add Vast/GPU action bundle.

Acceptance:

- Pipeline and Models pages explain the operational cause, not only the symptom.

### Phase 6: Agent Cockpit Parity (2 weeks)

Goal: make agent pages reliable enough for daily use.

Tasks:

- Extract shared `AgentRuntimeBar`.
- Extract shared `AgentModelPicker`.
- Use shared `TranscriptControls` on all agent pages.
- Replace native delete/yolo confirms with modals.
- Add disabled-state evidence for unsupported controls.
- Add session health and auth state.
- Add one-click Builder handoff.
- Add AI Vault logging review.

Acceptance:

- Claude, Codex, Gemini, and OpenCode feel like variants of one product.

### Phase 7: Builder as Repeatable Work System (3 weeks)

Goal: make Builder useful beyond demos.

Tasks:

- Connect Builder projects to real stack paths.
- Add stack templates:
  - NewsBites feature slice,
  - dashboard slice,
  - Mimule/OpenClaw fix,
  - editorial pipeline fix,
  - model/GPU ops task.
- Add stale-lock cleanup flow.
- Add validation summary.
- Add changed-file and artifact review.
- Add "promote to recurring workflow" action.
- Add plan-progress checkpoints.

Acceptance:

- Builder can run a real dashboard or NewsBites task and produce a usable handoff.

### Phase 8: Incident Lifecycle and Doctor 2.0 (2 weeks)

Goal: turn diagnostics into remediation.

Tasks:

- Incident lifecycle: open, acknowledged, investigating, mitigated, resolved.
- Attach events, jobs, actions, reports, and logs to incidents.
- Add runbook-backed recommendations.
- Add safe remediation tiers:
  - suggest only,
  - low-risk auto,
  - approval required.
- Add post-incident summary.

Acceptance:

- Incidents become operational records, not just alerts.

### Phase 8.5: Governance Control Plane (2 weeks)

Goal: make Governance complete enough to trust AI-operated work.

Tasks:

- Add Microsoft-style policy model.
- Add Conditional Access, MFA, SSO, labeling, sensitive-info, network, and AI-safety policy categories.
- Add AI call/run trace ingestion for successful and failed runs.
- Add run detail page with messages, tool calls, files, network, policies, safety, outputs, validations, and conclusions.
- Add policy evaluation results per run.
- Add Compliance report center with durable downloads.

Acceptance:

- Operator can inspect any AI run in detail.
- Successful runs are as visible as failed runs.
- Compliance reports generate downloadable evidence bundles.

### Phase 9: Polish and Performance (1 week)

Goal: make the product feel finished.

Tasks:

- Code-split heavy routes.
- Remove unused/lab routes from default bundle if practical.
- Run multi-viewport visual checks on all core routes.
- Reduce inline style count in core pages.
- Normalize table behavior on mobile.
- Ensure no overlapping text, nav, or modal controls.
- Add empty/loading/error states to every core page.

Acceptance:

- The app is usable on desktop and phone.
- Bundle warning is resolved or documented with a concrete follow-up.

### Phase 10: Packaging Later (after core product is valuable)

Only after the private control surface is valuable:

- revisit tenants,
- revisit license tiers,
- revisit marketplace,
- revisit public installer,
- revisit SOC2/compliance pages,
- revisit generic autonomy platform blocks.

These should not drive current navigation or design.

## 13. Engineering Backlog

### P0

- Hide or mark unfinished nav sections.
- Fix mobile primary nav index bug.
- Replace raw protected `fetch` calls with `authFetch`.
- Remove native browser prompts/confirms.
- Fix report data correctness.
- Add durable compliance report artifacts and downloads.
- Add workload graph for successful and failed work.
- Add route readiness registry.
- Add source-degraded UI states.

### P1

- Implement `OperatorReport`.
- Add real stack reports.
- Add compliance report center.
- Build `PriorityDeck`.
- Add action/evidence drawer.
- Add full AI run trace detail.
- Add Production page.
- Normalize agent page controls.
- Add incident lifecycle.

### P2

- Code splitting.
- Builder templates.
- Telegram report delivery.
- AI Vault report logging.
- Scheduled reports.
- Model routing simulator.
- Backup verification workflow.

### P3

- Marketplace.
- Public setup wizard.
- License tiers.
- Cloud tier.
- SOC2-style compliance center.
- Generic reusable block platform.

## 14. Quality Gates

Every shippable slice must pass:

- `bun run typecheck`
- `bun run build`
- focused unit/API tests
- relevant endpoint smoke tests
- visual checks for touched pages across desktop, tablet, and phone
- no unhandled 401/403 states
- no dead-end entity rows
- no native `alert`, `confirm`, or `prompt`
- updated report/action evidence where behavior changes
- downloadable artifacts for every generated compliance report
- success and failure workload coverage for changed domains

For UI routes:

- no horizontal overflow at 390px, 768px, 1440px,
- touch targets >= 44px on mobile,
- no text overlap,
- no card-inside-card clutter,
- no hidden critical action below unrelated filler.

## 15. Measurement

The product is usable when these are true:

- Morning check takes under 2 minutes.
- A stuck story can be diagnosed and acted on from the dashboard.
- A model outage/rate limit can be understood and mitigated from the dashboard.
- A failed service can be restarted with visible risk and evidence.
- A daily report can be generated and logged without hand-built commands.
- Compliance reports can be generated, downloaded, and verified.
- Successful AI work can be traced to jobs, articles, tool calls, outputs, and conclusions.
- A coding-agent session can be started, monitored, logged, and turned into a Builder workflow.
- The operator can use the core flows from mobile.
- The nav contains no confusing unfinished top-level pages.

## 16. External Reference Models

Use these as product-shape references during implementation:

- Microsoft Entra Conditional Access: assignments, conditions, access controls, report-only/enforced evaluation.
- Microsoft Purview Information Protection: discover, label, protect, sensitive info detection, DLP.
- Microsoft Defender XDR: incidents that correlate alerts, assets, investigations, evidence, and guided response.
- Splunk Enterprise Security: risk events, risk objects, risk notables, and risk-based alerting.
- ServiceNow GRC: authority documents, policy/control relationships, indicators, owner tasks, evidence workbench.
- Vanta/Drata-style compliance automation: continuous evidence collection, readiness roadmap, audit packages.
- AWS Security Hub / Google Security Command Center: findings, controls, standards, compliance status, security scores, affected resources.
- NIST AI RMF / ISO 42001: AI governance, mapping, measuring, managing, controls, monitoring, continual improvement.
- Azure AI Foundry / OpenTelemetry: AI-agent tracing with quality, performance, safety, cost, and tool-call observability.

## 17. Recommended Next Slice

Start with Phase 0 plus the first part of Phase 1:

1. Add route readiness metadata and simplify nav.
2. Fix mobile primary nav.
3. Add experimental badges to lab pages.
4. Replace raw protected fetches in Reports, Governance, Compliance, Projects, Marketplace, and Setup.
5. Create the first `PriorityDeck` implementation using existing `/api/mission-control` data.
6. Add the first workload graph table covering successful and failed NewsBites, Autopipeline, Builder, and agent work.
7. Make Compliance generate and download one real evidence bundle end to end.

This is the shortest path from "lots of incomplete pages" to "one page I can open every day and trust."

## 18. AREA 1: Alerting and Notification Center

### A. Feature And Stack Value

Add a dashboard-native alert rules engine that turns stack evidence into routed, acknowledged, suppressible alerts. This matters because the MIMULE / TechInsiderBytes stack is operated by one person across NewsBites, TIB Markets, Autopipeline, Paperclip, Mimule/OpenClaw, LiteLLM, Vast.ai GPU, OpenCode, Caddy, Cloudflare Tunnel, Docker, systemd, and AI Vault. The product needs to distinguish "watch this" from "wake up and act" without flooding Telegram.

Alert severities:

| Severity | Meaning For This Stack | Default Routing |
|---|---|---|
| `info` | Useful state change or successful automated process. | In-app notification center and dashboard badge. |
| `warning` | Degradation that can wait but should be reviewed same day. | In-app, Today badge; Telegram only if opted in. |
| `critical` | User-visible failure, production pipeline block, or budget/capacity risk. | In-app, dashboard badge, Telegram if opted in. |
| `page` | Single-operator urgent condition: public site down, GPU tunnel unavailable during active work, backup absent, or unbounded spend. | Telegram re-ping, in-app persistent banner, auto-open incident if unacknowledged. |

### B. User Stories

- As operator, I want the dashboard to tell me when the GPU tunnel has been down for more than 5 minutes so I can restore local model routing before Autopipeline falls back to paid providers.
- As operator, I want repeat failures from the same public URL probe to become one alert, not dozens of Telegram messages.
- As operator, I want to acknowledge "I am handling this" from mobile without marking the condition resolved.
- As operator, I want to mute known maintenance noise for N hours while preserving the event history.
- As operator, I want a morning view of what fired overnight with evidence and links to incidents, logs, and affected services.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `alert_rules` | `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `description TEXT`, `source_type TEXT NOT NULL`, `condition_type TEXT NOT NULL`, `condition_json TEXT NOT NULL`, `severity TEXT NOT NULL`, `enabled INTEGER NOT NULL DEFAULT 1`, `dedupe_key_template TEXT NOT NULL`, `evaluation_interval_sec INTEGER NOT NULL`, `for_duration_sec INTEGER NOT NULL DEFAULT 0`, `channels_json TEXT NOT NULL`, `escalation_json TEXT`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` | `idx_alert_rules_enabled_source(enabled, source_type)` |
| `alert_firings` | `id TEXT PRIMARY KEY`, `rule_id TEXT NOT NULL`, `dedupe_key TEXT NOT NULL`, `entity_type TEXT`, `entity_id TEXT`, `severity TEXT NOT NULL`, `status TEXT NOT NULL`, `first_fired_at INTEGER NOT NULL`, `last_fired_at INTEGER NOT NULL`, `fire_count INTEGER NOT NULL DEFAULT 1`, `last_evidence_json TEXT NOT NULL`, `incident_id TEXT`, `acknowledged_at INTEGER`, `acknowledged_by TEXT`, `resolved_at INTEGER`, `resolved_by TEXT` | `idx_alert_firings_rule_status(rule_id, status)`, `idx_alert_firings_dedupe_open(dedupe_key, status)`, `idx_alert_firings_ts(last_fired_at)` |
| `alert_events` | `id TEXT PRIMARY KEY`, `firing_id TEXT NOT NULL`, `event_type TEXT NOT NULL`, `ts INTEGER NOT NULL`, `actor TEXT`, `message TEXT`, `payload_json TEXT` | `idx_alert_events_firing_ts(firing_id, ts)` |
| `alert_suppressions` | `id TEXT PRIMARY KEY`, `rule_id TEXT`, `dedupe_key TEXT`, `entity_type TEXT`, `entity_id TEXT`, `reason TEXT NOT NULL`, `starts_at INTEGER NOT NULL`, `ends_at INTEGER NOT NULL`, `created_by TEXT NOT NULL`, `created_at INTEGER NOT NULL` | `idx_alert_suppressions_active(starts_at, ends_at)`, `idx_alert_suppressions_key(dedupe_key)` |
| `notification_deliveries` | `id TEXT PRIMARY KEY`, `firing_id TEXT NOT NULL`, `channel TEXT NOT NULL`, `target TEXT`, `status TEXT NOT NULL`, `attempt_count INTEGER NOT NULL DEFAULT 0`, `last_attempt_at INTEGER`, `last_error TEXT`, `rate_limited_until INTEGER` | `idx_notification_deliveries_firing(firing_id)`, `idx_notification_deliveries_channel_status(channel, status)` |

Condition JSON supports `metric_threshold`, `event_absence`, `consecutive_probe_failure`, `error_rate_spike`, `file_age`, `directory_growth_rate`, `schedule_miss`, and `ai_vault_log_absence`. Each rule stores the exact evidence query inputs rather than hardcoded backend names.

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/alerts/rules` | `GET` | `?enabled=&source_type=` | `{ rules: AlertRule[] }` | Operator |
| `/api/alerts/rules` | `POST` | `{ name, source_type, condition_type, condition_json, severity, channels, for_duration_sec }` | `{ rule }` | Admin |
| `/api/alerts/rules/:id` | `PATCH` | Partial rule fields | `{ rule }` | Admin |
| `/api/alerts/firings` | `GET` | `?status=&severity=&from=&to=&entity_type=` | `{ firings }` | Operator |
| `/api/alerts/firings/:id/ack` | `POST` | `{ note?: string }` | `{ firing }` | Operator |
| `/api/alerts/firings/:id/resolve` | `POST` | `{ resolution_note: string }` | `{ firing }` | Operator |
| `/api/alerts/suppressions` | `POST` | `{ rule_id?, dedupe_key?, entity_type?, entity_id?, duration_hours, reason }` | `{ suppression }` | Operator |
| `/api/alerts/evaluate` | `POST` | `{ rule_id?: string }` | `{ evaluated, fired, suppressed }` | Automation |
| `/api/notifications` | `GET` | `?unread=&limit=` | `{ notifications }` | Operator |
| `/api/notifications/:id/read` | `POST` | `{}` | `{ ok: true }` | Operator |

### E. UI Spec

Host this in a new `Alerts` drawer reachable from the global bell badge, Today priority cards, Incidents, Infra, Models, and Settings. The drawer shows Open, Acknowledged, Suppressed, and History tabs. Each alert card shows severity, affected stack entity, first/last fired time, evidence, current routing, nearest action, acknowledge, mute, create/open incident, and view logs.

Settings gets an Alert Rules page with templates, channel preferences, suppression list, and Telegram rate-limit state. Mobile uses a full-height sheet with large acknowledge/mute buttons and no table-only views. Dashboard badges show both successful notifications and errors: for example "3 alerts open, 12 checks passed in last hour."

### F. Integration Points

- Existing service, timer, Docker, backup, disk, and public URL probes.
- LiteLLM gateway call data and `/var/lib/mimule/model-health.json`.
- Vast.ai balance and autossh tunnel health.
- Autopipeline API at `127.0.0.1:3200` and dossier queue timestamps.
- AI Vault daily/project logs under `/opt/ai-vault`.
- Mimule/OpenClaw Telegram bridge through existing bot only.
- Incidents, jobs, audit, and future log aggregation tables.

Pre-built templates:

| Template | Condition |
|---|---|
| GPU tunnel down | `vast-tunnel` unhealthy or `127.0.0.1:11434` unavailable for `>300s`. |
| Autopipeline queue stale | Oldest active queue item age `>7200s` with no stage progress event. |
| Live service non-200 | `newsbites`, `tib-markets`, or `opencode` public/internal probe fails 3 consecutive times. |
| Vast runway low | Balance-derived GPU time `<72h` at `$0.138/hr`. |
| LiteLLM model errors | Error rate `>20%` for any logical model over `15m`. |
| Disk usage high | Any monitored mount crosses `80%`. |
| Publish cadence missed | No article published in `>18h` during configured Autopipeline operating hours. |
| Agent log missing | Active agent session has no AI Vault log after `30m` of work. |
| Backup stale | No successful verified backup in `25h`. |
| Dashboard DB growth | Dashboard SQLite size growth rate `>2x` 30-day baseline. |

### G. Phase Placement

Insert as Phase 1.5 after Today has a priority deck and before Phase 2 reports. Alerting supplies the event language for cost alerts, public URL health, capacity projections, schedules, provider status, and model quality incidents.

### H. Acceptance Criteria

1. A GPU tunnel outage lasting more than 5 minutes creates exactly one open firing with repeated evidence updates, not repeated alert rows.
2. Acknowledging an alert changes its status and records an audit event without resolving the underlying condition.
3. Muting an alert for 2 hours suppresses Telegram and badge escalation while preserving `alert_events`.
4. An unacknowledged `page` severity firing after 30 minutes re-pings Telegram and creates or links an incident.
5. Alert history shows overnight firings grouped by rule and affected entity on mobile.

### I. Risks

- Telegram noise can make alerts useless; rate limits and opt-in routing must ship with the first Telegram channel.
- Bad dedupe keys could hide distinct incidents; templates need entity-aware keys such as `service:newsbites:http_status`.

## 19. AREA 2: Cost, Budget, and Spend Management

### A. Feature And Stack Value

Add budget definitions, real-time spend tracking, burn-rate projections, provider fallback visibility, and cost recommendations. This matters because the stack intentionally prefers free OpenRouter and local GPU paths, but Vast.ai time, GitHub Models fallback, and paid cloud providers can create real spend without a second operator watching.

### B. User Stories

- As operator, I want to know today whether paid fallback was used for NewsBites or Builder work.
- As operator, I want a monthly ceiling and per-workflow budgets so Autopipeline cannot quietly become expensive.
- As operator, I want per-article and per-dossier cost attribution before deciding what to automate more.
- As operator, I want Vast.ai runway displayed in hours and days, not just balance.
- As operator, I want optimization suggestions that use LiteLLM logical names and existing routing policy, not hardcoded backends.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `budget_definitions` | `id TEXT PRIMARY KEY`, `scope_type TEXT NOT NULL`, `scope_id TEXT`, `tier TEXT NOT NULL`, `period TEXT NOT NULL`, `currency TEXT NOT NULL DEFAULT 'USD'`, `amount_cents INTEGER NOT NULL`, `warning_pct REAL NOT NULL DEFAULT 0.8`, `critical_pct REAL NOT NULL DEFAULT 1.0`, `enabled INTEGER NOT NULL DEFAULT 1`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` | `idx_budgets_scope(scope_type, scope_id, period)`, `idx_budgets_enabled(enabled)` |
| `cost_events` | `id TEXT PRIMARY KEY`, `ts INTEGER NOT NULL`, `source TEXT NOT NULL`, `logical_model TEXT`, `provider TEXT`, `tier TEXT NOT NULL`, `workflow_type TEXT`, `workflow_id TEXT`, `project TEXT`, `article_slug TEXT`, `dossier_id TEXT`, `builder_run_id TEXT`, `gateway_call_id TEXT`, `input_tokens INTEGER`, `output_tokens INTEGER`, `cost_cents REAL NOT NULL DEFAULT 0`, `cost_basis TEXT NOT NULL`, `fallback_reason TEXT`, `metadata_json TEXT` | `idx_cost_events_ts(ts)`, `idx_cost_events_scope(workflow_type, workflow_id)`, `idx_cost_events_model(logical_model, ts)`, `idx_cost_events_article(article_slug)` |
| `provider_price_catalog` | `id TEXT PRIMARY KEY`, `provider TEXT NOT NULL`, `logical_model TEXT`, `tier TEXT NOT NULL`, `input_cents_per_1k REAL`, `output_cents_per_1k REAL`, `hourly_cents REAL`, `effective_from INTEGER NOT NULL`, `effective_to INTEGER`, `source_note TEXT` | `idx_price_catalog_provider_model(provider, logical_model)` |
| `spend_anomalies` | `id TEXT PRIMARY KEY`, `ts INTEGER NOT NULL`, `scope_type TEXT NOT NULL`, `scope_id TEXT`, `baseline_cents REAL NOT NULL`, `observed_cents REAL NOT NULL`, `multiplier REAL NOT NULL`, `status TEXT NOT NULL`, `alert_firing_id TEXT` | `idx_spend_anomalies_ts_status(ts, status)` |

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/cost/budgets` | `GET` | `?scope_type=&period=` | `{ budgets, spendByBudget }` | Operator |
| `/api/cost/budgets` | `POST` | `{ scope_type, scope_id?, tier, period, amount_cents, warning_pct, critical_pct }` | `{ budget }` | Admin |
| `/api/cost/spend` | `GET` | `?from=&to=&group_by=model|workflow|article|tier|provider` | `{ totals, groups }` | Operator |
| `/api/cost/runway/vast` | `GET` | none | `{ hourly_cents, balance_cents, hours_remaining, days_remaining, last_checked_at }` | Operator |
| `/api/cost/attribution/:entityType/:entityId` | `GET` | none | `{ entity, events, totals }` | Operator |
| `/api/cost/fallbacks` | `GET` | `?from=&to=` | `{ fallbacks }` | Operator |
| `/api/cost/recommendations` | `POST` | `{ scope_type?, scope_id? }` | `{ recommendations, model_used }` | Operator |

### E. UI Spec

Add a Cost tab to Models and a Budget page under Settings. Today shows budget warnings only when actionable. The Cost tab includes monthly spend, burn-rate line, projected overage date, Vast runway card, paid fallback timeline, top expensive articles/dossiers/Builder runs, and optimization recommendations. Mobile uses stacked summary cards with drill-in sheets for attribution details.

### F. Integration Points

- `gateway_calls` or equivalent LiteLLM call trace table for model, tokens, latency, provider, and error class.
- LiteLLM API/config at `:4000` and `/etc/litellm/config.yaml` for logical route mapping.
- Vast.ai balance and current GPU hourly price `$0.138/hr`.
- Autopipeline dossier IDs, NewsBites article slugs, Builder run IDs, and agent sessions.
- Alerting Center for budget, runway, fallback, and anomaly alerts.
- AI Vault logging for generated cost recommendation summaries.

### G. Phase Placement

Extend Phase 5 because it is model-routing adjacent, with alert hooks dependent on Area 1. Basic spend ingestion should land before Phase 2 Model Reliability and Cost Report becomes authoritative.

### H. Acceptance Criteria

1. Every LiteLLM call with token/cost metadata creates or updates a `cost_events` row tied to a logical model.
2. Paid fallback calls are shown separately from free-cloud and local-GPU calls with the recorded trigger reason.
3. Vast runway displays days remaining from live balance and `$0.138/hr`, with a configurable alert threshold.
4. Per-article and per-dossier pages show summed model cost for their originating pipeline stages.
5. A 3x hourly cost spike creates a spend anomaly and can fire a budget alert.

### I. Risks

- Provider price data may be incomplete or change; every estimate must show `cost_basis` and avoid pretending unknown cost is exact.
- Attribution can be wrong if gateway calls are not linked to dossier/article/run IDs; the first milestone must improve trace propagation.

## 20. AREA 3: Secrets and Credential Management

### A. Feature And Stack Value

Add credential inventory, expiry/health signals, rotation reminders, guided rotation checklists, and secret-detection linkage. This is not a secrets vault. It never stores secret values. It matters because OpenRouter, GitHub Models, Vast.ai, Cloudflare, Telegram, Caddy, LiteLLM, and deployment credentials are spread across env files, config files, Docker env, and systemd units.

### B. User Stories

- As operator, I want to know which credentials exist and where they are configured without exposing values.
- As operator, I want auth failures in logs to point back to the likely credential inventory entry.
- As operator, I want a safe rotation checklist for the Telegram bot token or Cloudflare token before touching production.
- As operator, I want reminders before known expirations and after stale rotations.
- As operator, I want secret detector hits in AI prompts/outputs linked to the real credential they appear to match.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `credential_inventory` | `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `service TEXT NOT NULL`, `credential_type TEXT NOT NULL`, `location_type TEXT NOT NULL`, `location_path TEXT NOT NULL`, `env_key TEXT`, `fingerprint_hint TEXT`, `expiry_at INTEGER`, `last_rotated_at INTEGER`, `owner TEXT NOT NULL DEFAULT 'operator'`, `rotation_interval_days INTEGER`, `status TEXT NOT NULL DEFAULT 'unknown'`, `notes TEXT`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` | `idx_credentials_service(service)`, `idx_credentials_expiry(expiry_at)`, `idx_credentials_status(status)` |
| `credential_health_events` | `id TEXT PRIMARY KEY`, `credential_id TEXT`, `ts INTEGER NOT NULL`, `source TEXT NOT NULL`, `event_type TEXT NOT NULL`, `severity TEXT NOT NULL`, `message TEXT NOT NULL`, `evidence_ref TEXT`, `log_entry_id TEXT` | `idx_cred_health_credential_ts(credential_id, ts)`, `idx_cred_health_type(event_type, ts)` |
| `credential_rotation_runs` | `id TEXT PRIMARY KEY`, `credential_id TEXT NOT NULL`, `status TEXT NOT NULL`, `started_at INTEGER NOT NULL`, `completed_at INTEGER`, `steps_json TEXT NOT NULL`, `operator_notes TEXT`, `audit_id TEXT` | `idx_cred_rotation_credential_ts(credential_id, started_at)` |
| `credential_access_events` | `id TEXT PRIMARY KEY`, `credential_id TEXT`, `ts INTEGER NOT NULL`, `consumer_service TEXT NOT NULL`, `access_type TEXT NOT NULL`, `result TEXT NOT NULL`, `evidence_ref TEXT`, `audit_id TEXT` | `idx_cred_access_credential_ts(credential_id, ts)`, `idx_cred_access_service(consumer_service, ts)` |
| `sensitive_detection_links` | `id TEXT PRIMARY KEY`, `sensitive_detection_id TEXT NOT NULL`, `credential_id TEXT NOT NULL`, `match_confidence REAL NOT NULL`, `created_at INTEGER NOT NULL` | `idx_sensitive_links_detection(sensitive_detection_id)`, `idx_sensitive_links_credential(credential_id)` |

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/credentials` | `GET` | `?service=&status=` | `{ credentials }` | Admin |
| `/api/credentials` | `POST` | `{ name, service, credential_type, location_type, location_path, env_key?, expiry_at? }` | `{ credential }` | Admin |
| `/api/credentials/:id` | `PATCH` | Metadata only; no secret value | `{ credential }` | Admin |
| `/api/credentials/:id/health` | `GET` | none | `{ credential, events, detections }` | Admin |
| `/api/credentials/:id/rotation-template` | `GET` | none | `{ steps, affected_services, verification_checks }` | Admin |
| `/api/credentials/:id/rotation-runs` | `POST` | `{ steps_json?, notes? }` | `{ run }` | Admin |
| `/api/credentials/:id/rotation-runs/:runId/step` | `POST` | `{ step_id, status, note? }` | `{ run }` | Admin |
| `/api/credentials/discover` | `POST` | `{ paths?: string[] }` | `{ candidates, warnings }` | Admin |

### E. UI Spec

Host in Settings under `Credentials`. The inventory table shows name, service, location, expiry, last rotation, health, and linked detections. Detail drawer shows non-secret metadata, health timeline, consumers, rotation checklist, and related audit events. Mobile uses cards grouped by service with a safe "copy path" action, never "show secret."

### F. Integration Points

- `/etc/litellm/config.yaml`, systemd env files, Docker compose/env, Caddy/Cloudflare config references, `/opt/mimoun`, `/opt/opencode-control-surface`, and service unit definitions.
- Unified log aggregation for auth failures, 401/403, provider quota, and rate-limit messages.
- Sensitive-info detector tables already planned under governance/data protection.
- Alerting Center for expiry/reminder/auth-failure alerts.
- Audit chain for checklist confirmations and credential access events.

### G. Phase Placement

Extend Phase 8.5 Governance Control Plane as a private-stack operational security feature, with alert hooks after Area 1 and log health after Area 6.

### H. Acceptance Criteria

1. Credential inventory stores only metadata, path, env key, and fingerprint hints; no secret value is persisted.
2. A Telegram bot token rotation checklist includes update location, service restart, and bot verification steps.
3. Auth failure log entries can be linked to a credential health event and inventory entry.
4. A credential expiring within its reminder window creates an in-app notification and optional Telegram alert.
5. A sensitive-info hit in an AI output can show the related credential inventory record without revealing the secret.

### I. Risks

- Discovery can accidentally read or display secret values; scanners must redact values at source and store only metadata.
- Rotation steps can break production if too generic; each template must be service-specific and audited.

## 21. AREA 4: Cost and Capacity Trend Analysis

### A. Feature And Stack Value

Add historical capacity sampling, rolling trends, forward projections, cleanup recommendations, and VPS upgrade triggers. The stack currently depends on one VPS, local SQLite databases, dossier directories, Builder runs, AI Vault markdown, and a Vast.ai GPU tunnel; capacity problems can block publishing and agent work before service health flips red.

### B. User Stories

- As operator, I want to know when `/opt` will fill at current dossier and Builder growth rates.
- As operator, I want daily summaries of dashboard, NewsBites, and TIB Markets SQLite growth.
- As operator, I want the dashboard to recommend log/archive cleanup before the VPS is in crisis.
- As operator, I want to know when CX32 limits are being reached often enough to justify upgrade.
- As operator, I want cost and model volume trends in the same view as capacity trends.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `capacity_samples` | `id TEXT PRIMARY KEY`, `ts INTEGER NOT NULL`, `metric_name TEXT NOT NULL`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `value REAL NOT NULL`, `unit TEXT NOT NULL`, `source TEXT NOT NULL`, `metadata_json TEXT` | `idx_capacity_metric_entity_ts(metric_name, entity_type, entity_id, ts)`, `idx_capacity_ts(ts)` |
| `capacity_daily_summaries` | `id TEXT PRIMARY KEY`, `day TEXT NOT NULL`, `metric_name TEXT NOT NULL`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `min_value REAL`, `max_value REAL`, `avg_value REAL`, `last_value REAL`, `sample_count INTEGER NOT NULL`, `wow_delta_pct REAL`, `created_at INTEGER NOT NULL` | `idx_capacity_daily(day, metric_name, entity_id)` |
| `capacity_projections` | `id TEXT PRIMARY KEY`, `ts INTEGER NOT NULL`, `metric_name TEXT NOT NULL`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `current_value REAL NOT NULL`, `daily_growth REAL NOT NULL`, `projected_limit_value REAL`, `projected_limit_ts INTEGER`, `confidence TEXT NOT NULL`, `recommendation TEXT`, `alert_firing_id TEXT` | `idx_capacity_projection_entity(metric_name, entity_id, ts)` |
| `capacity_recommendations` | `id TEXT PRIMARY KEY`, `ts INTEGER NOT NULL`, `severity TEXT NOT NULL`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `title TEXT NOT NULL`, `recommendation TEXT NOT NULL`, `threshold_json TEXT NOT NULL`, `status TEXT NOT NULL` | `idx_capacity_rec_status(status, ts)` |

Hourly samples are retained for 30 days; six-hour samples are treated as hourly-class samples. Daily summaries are kept indefinitely.

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/capacity/samples` | `GET` | `?metric=&entity_type=&entity_id=&from=&to=` | `{ samples }` | Operator |
| `/api/capacity/trends` | `GET` | `?metrics=&window=7d|30d` | `{ trends, rollingAverages, wowDeltas }` | Operator |
| `/api/capacity/projections` | `GET` | `?entity_type=&entity_id=` | `{ projections }` | Operator |
| `/api/capacity/recommendations` | `GET` | `?status=` | `{ recommendations }` | Operator |
| `/api/capacity/sample-now` | `POST` | `{ metric_names?: string[] }` | `{ sampled, failed }` | Automation |

### E. UI Spec

Extend Infra with a `Trends` tab. It shows mount usage for `/`, `/var`, `/opt`, DB sizes, dossier size, AI Vault size, Builder run size, RAM by service, CPU load, Vast spend/day, model calls/day, article production/week, and Autopipeline queue depth. Charts include 7-day and 30-day averages, deploy markers from Area 7, and projection cards. Mobile uses one metric group per sheet with "why this matters" and "recommended cleanup" actions.

### F. Integration Points

- Filesystem checks for `/`, `/var`, `/opt`, `/opt/ai-vault`, Builder run directories, and editorial dossier directories.
- SQLite file paths for dashboard, NewsBites, and TIB Markets.
- systemd/Docker stats for service RAM and CPU.
- Vast.ai spend events from Area 2.
- LiteLLM logical model call counts.
- NewsBites article publish metadata and Autopipeline queue API.
- Alerting Center for projection `<14d`, DB `>1GB`, dossier `>20GB`, and CX32 upgrade triggers.

### G. Phase Placement

Extend Phase 5/Infra and Phase 9. Capacity projections should ship before heavy report/evidence retention expands storage.

### H. Acceptance Criteria

1. `capacity_samples` records all required metrics at least every 6 hours.
2. The trend API returns 7-day average, 30-day average, and week-over-week delta for disk and DB sizes.
3. A mount projected to fill in fewer than 14 days creates an alertable projection.
4. Dashboard DB size above 1GB creates an archive-old-run-logs recommendation.
5. Sustained CPU load, RAM pressure, or swap pressure above configured CX32 thresholds surfaces a VPS upgrade card.

### I. Risks

- Directory-size scans can be expensive on large dossier trees; sampling must cap runtime and record degraded-source status.
- Linear projections can overstate risk after one-time imports; confidence and deploy/change annotations must be visible.

## 22. AREA 5: Global Search and Command Palette

### A. Feature And Stack Value

Add cross-entity search, stable deep links, saved filters, recent items, and a Cmd+K/Ctrl+K command palette. This matters because the operator navigates between articles, dossiers, runs, incidents, jobs, policies, reports, agent sessions, services, models, deploys, alerts, and logs during one incident or production session.

### B. User Stories

- As operator, I want to type an article slug or dossier topic and jump directly to its detail drawer.
- As operator, I want Cmd+K on desktop and a mobile search sheet to run common actions without hunting through pages.
- As operator, I want to reopen the last 10 entities I touched.
- As operator, I want saved filters like critical incidents from the last 7 days.
- As operator, I want every result to have a bookmarkable URL.

### C. Data Model

Use SQLite FTS5 with a normalized backing table. FTS5 gives fast local full-text search without adding a new service.

| Table | Columns | Indices |
|---|---|---|
| `search_entities` | `id TEXT PRIMARY KEY`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `title TEXT NOT NULL`, `subtitle TEXT`, `url TEXT NOT NULL`, `status TEXT`, `updated_at INTEGER NOT NULL`, `source TEXT NOT NULL`, `metadata_json TEXT` | `idx_search_entity_unique(entity_type, entity_id)`, `idx_search_entity_updated(updated_at)` |
| `search_entities_fts` | FTS5 virtual table over `title`, `subtitle`, `metadata_text`, content=`search_entities` | FTS5 index |
| `saved_searches` | `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `query TEXT NOT NULL`, `filters_json TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` | `idx_saved_searches_updated(updated_at)` |
| `command_history` | `id TEXT PRIMARY KEY`, `command_id TEXT NOT NULL`, `entity_type TEXT`, `entity_id TEXT`, `executed_at INTEGER NOT NULL`, `result TEXT NOT NULL` | `idx_command_history_executed(executed_at)` |

Recent items stay in localStorage as `control_surface_recent_entities` with the last 20 deep links.

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/search` | `GET` | `?q=&types=&limit=` | `{ groups: Record<string, SearchResult[]> }` | Operator |
| `/api/search/reindex` | `POST` | `{ entity_types?: string[] }` | `{ indexed, failed }` | Automation |
| `/api/commands` | `GET` | `?q=&context=` | `{ commands }` | Operator |
| `/api/commands/:id/execute` | `POST` | `{ args?: object, reason?: string }` | `{ job?, result, audit_id }` | Operator; Admin for high risk |
| `/api/saved-searches` | `GET` | none | `{ searches }` | Operator |
| `/api/saved-searches` | `POST` | `{ name, query, filters_json }` | `{ search }` | Operator |

### E. UI Spec

Desktop top nav gets a compact search input and Cmd+K/Ctrl+K palette. Mobile gets a slide-up search sheet from the top bar and bottom-nav More menu. Results group by entity type and show status, freshness, and source. Commands include navigation, low-risk actions, entity open commands, recent items, and saved searches. Keyboard navigation supports arrows, Enter, Escape, and `?` for shortcuts.

Deep link scheme:

| Entity | URL |
|---|---|
| Article | `/production/articles/:slug` |
| Dossier | `/pipeline/dossiers/:dossierId` |
| Run/job | `/jobs/:jobId` |
| Incident | `/incidents/:incidentId` |
| Alert | `/alerts/:firingId` |
| Service | `/infra/services/:serviceName` |
| Model | `/models/:logicalName` |
| Report | `/reports/:reportRunId` |
| Policy | `/governance/policies/:policyId` |
| Agent session | `/agents/:agentType/sessions/:sessionId` |
| Deploy | `/deploys/:deployId` |
| Log query | `/logs?query=...` |

### F. Integration Points

- NewsBites article metadata and slugs.
- Autopipeline dossiers and queue items.
- Incidents, jobs, reports, policies, alerts, deploys, services, models, agent sessions, and log entries.
- Action engine for command execution.
- Operator workspace pins/notes/tasks from Area 12.

### G. Phase Placement

Insert after Phase 3 actionability and before Phase 4/5 deep workflow expansion. Search makes the expanding entity graph navigable.

### H. Acceptance Criteria

1. Searching an existing article slug, service name, logical model, incident ID, and report title returns grouped results in under 300ms on the VPS.
2. Cmd+K/Ctrl+K opens the command palette on desktop; mobile opens the same commands in a slide-up sheet.
3. Each result opens a stable deep link that can be bookmarked and reloaded.
4. Saved searches persist in SQLite and appear as command palette entries.
5. Recent items are stored only in localStorage and survive page reloads.

### I. Risks

- Stale search index entries can send the operator to dead links; every result must carry source freshness and tolerate missing entities.
- Command execution from search can bypass context; high-risk commands still need preview, reason, and audit.

## 23. AREA 6: Unified Log Aggregation and Search

### A. Feature And Stack Value

Add normalized short-retention log ingestion from systemd, Docker, Caddy, and AI Vault, with search, correlation, live tails, incident linking, and export. This matters because incidents span systemd services, Docker containers, LiteLLM, Autopipeline, Caddy, and AI Vault notes, and today the operator must manually stitch together timelines.

### B. User Stories

- As operator, I want all logs around an incident timestamp in one ±5 minute view.
- As operator, I want to search for `401`, `rate limit`, or a dossier ID across systemd and Docker logs.
- As operator, I want to create an incident annotation from selected log lines.
- As operator, I want a live tail for `litellm` or `autopipeline` from mobile.
- As operator, I want to export filtered logs as JSONL for AI investigation or a postmortem.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `log_entries` | `id TEXT PRIMARY KEY`, `ts INTEGER NOT NULL`, `source_type TEXT NOT NULL`, `service TEXT NOT NULL`, `level TEXT NOT NULL`, `message TEXT NOT NULL`, `raw TEXT NOT NULL`, `cursor TEXT`, `metadata_json TEXT` | `idx_log_entries_service_ts(service, ts)`, `idx_log_entries_level_ts(level, ts)`, `idx_log_entries_ts(ts)` |
| `log_entries_fts` | FTS5 virtual table over `message`, `raw`, content=`log_entries` | FTS5 index |
| `log_ingest_cursors` | `source_id TEXT PRIMARY KEY`, `source_type TEXT NOT NULL`, `service TEXT NOT NULL`, `cursor TEXT`, `last_ts INTEGER`, `last_status TEXT`, `last_error TEXT`, `updated_at INTEGER NOT NULL` | `idx_log_ingest_status(last_status)` |
| `incident_log_links` | `id TEXT PRIMARY KEY`, `incident_id TEXT NOT NULL`, `log_entry_id TEXT NOT NULL`, `note TEXT`, `created_at INTEGER NOT NULL`, `created_by TEXT NOT NULL` | `idx_incident_log_links_incident(incident_id)`, `idx_incident_log_links_log(log_entry_id)` |

Retention: raw `info` lines 72 hours; `warning` and `error` lines 30 days; incident-linked lines retained with incident evidence.

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/logs/search` | `GET` | `?q=&service=&level=&from=&to=&limit=` | `{ entries, degradedSources }` | Operator |
| `/api/logs/correlation` | `GET` | `?ts=&window_sec=300&services=` | `{ entriesByService }` | Operator |
| `/api/logs/tail/:service` | `GET` | SSE stream | `event: log` rows | Operator |
| `/api/logs/link-incident` | `POST` | `{ incident_id, log_entry_ids, note? }` | `{ links }` | Operator |
| `/api/logs/export` | `POST` | `{ q?, service?, level?, from, to, format: 'jsonl'|'text' }` | `{ artifact_url, row_count }` | Operator |
| `/api/logs/ingest/status` | `GET` | none | `{ sources }` | Admin |

### E. UI Spec

Infra gets a `Logs` tab and every incident detail gets a `Related Logs` tab. The log UI has service chips, time range, level filters, search input, grouped timeline, selected-line evidence tray, create/annotate incident action, and export. Live tail uses a mobile-friendly single-column stream with pause, resume, copy excerpt, and create incident.

### F. Integration Points

- systemd journal for `newsbites`, `tib-markets`, `autopipeline`, `litellm`, `opencode`, `control-surface`, `vast-tunnel`, `mimule`, and timers.
- Docker stdout/stderr for `paperclip`, `openclaw_gateway`, and `goblin_game`.
- Caddy access logs.
- AI Vault daily markdown entries as structured log-like events with source path.
- Incidents, alerts, credential health, provider status, and deploy events.

### G. Phase Placement

Extend Phase 8 Incident Lifecycle and Phase 5 Infra. Ship ingestion after Area 1 so logs can feed alert evidence, but before advanced incident correlation.

### H. Acceptance Criteria

1. Log search returns normalized entries from at least one systemd service and one Docker container.
2. Incident correlation shows all ingested services in a ±5 minute window around an incident timestamp.
3. Live tail for an allowlisted service streams without exposing arbitrary shell access.
4. Selected log lines can be attached to an incident and retained beyond raw-log retention.
5. Filtered logs export as JSONL and plain text with redaction applied.

### I. Risks

- Log ingestion can grow SQLite quickly; retention and capacity alerts must be active before broad ingestion.
- Logs can contain secrets; sensitive detectors and redaction must run before export and AI summaries.

## 24. AREA 7: Deployment Tracking and Change History

### A. Feature And Stack Value

Add deployment events, health checks, rollback visibility, change summaries, and timeline annotations. This matters because NewsBites, TIB Markets, Control Surface, LiteLLM restarts, and Docker service updates can change behavior, cost, latency, or article production, and the operator needs to correlate "what changed" with incidents and trend charts.

### B. User Stories

- As operator, I want a NewsBites deploy to appear on the incident and latency timeline automatically.
- As operator, I want to see the commit SHA and changed-file summary for a failed deploy.
- As operator, I want dashboard restarts to register as deploy events with health probe results.
- As operator, I want Docker image pulls/container restarts recorded as change events.
- As operator, I want rollback actions visible only where a safe service-specific rollback exists.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `deploy_events` | `id TEXT PRIMARY KEY`, `service TEXT NOT NULL`, `version TEXT`, `commit_sha TEXT`, `previous_version TEXT`, `previous_commit_sha TEXT`, `deploy_ts INTEGER NOT NULL`, `completed_ts INTEGER`, `triggered_by TEXT NOT NULL`, `trigger_source TEXT NOT NULL`, `duration_ms INTEGER`, `result TEXT NOT NULL`, `changed_files_summary TEXT`, `diff_stat_json TEXT`, `health_status TEXT`, `health_probe_json TEXT`, `rollback_supported INTEGER NOT NULL DEFAULT 0`, `rollback_action_json TEXT`, `audit_id TEXT` | `idx_deploy_events_service_ts(service, deploy_ts)`, `idx_deploy_events_result(result, deploy_ts)` |
| `deploy_artifacts` | `id TEXT PRIMARY KEY`, `deploy_event_id TEXT NOT NULL`, `artifact_type TEXT NOT NULL`, `path TEXT`, `content_hash TEXT`, `metadata_json TEXT` | `idx_deploy_artifacts_event(deploy_event_id)` |
| `deploy_health_checks` | `id TEXT PRIMARY KEY`, `deploy_event_id TEXT NOT NULL`, `ts INTEGER NOT NULL`, `check_name TEXT NOT NULL`, `status TEXT NOT NULL`, `latency_ms INTEGER`, `message TEXT`, `evidence_json TEXT` | `idx_deploy_health_event_ts(deploy_event_id, ts)` |

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/deploys` | `GET` | `?service=&from=&to=&result=` | `{ deploys }` | Operator |
| `/api/deploys/events` | `POST` | `{ service, version?, commit_sha?, triggered_by, trigger_source, result, changed_files_summary? }` | `{ deploy_event }` | Automation |
| `/api/deploys/:id` | `GET` | none | `{ deploy, artifacts, health_checks }` | Operator |
| `/api/deploys/:id/health-check` | `POST` | `{ checks?: string[] }` | `{ health_status, checks }` | Automation |
| `/api/deploys/:id/rollback-preview` | `GET` | none | `{ supported, steps, risk, previous_version }` | Admin |
| `/api/deploys/:id/rollback` | `POST` | `{ reason }` | `{ job, audit_id }` | Admin |

### E. UI Spec

Add a Deploys timeline under Infra and service detail drawers. Deploy markers appear on capacity, public URL latency, model calls, incident timeline, and provider charts. A deploy detail drawer shows service, commit, previous commit, changed files, duration, health, related alerts/incidents, and rollback preview if supported. Mobile shows chronological deploy cards with pass/fail badges and health summary.

### F. Integration Points

- NewsBites `deploy.sh` posts to dashboard API.
- Control Surface startup hook records version and commit after restart.
- TIB Markets follows the same hook pattern as NewsBites.
- Docker event watcher records image pull and container restart for Paperclip, OpenClaw gateway, and other stack containers.
- Git diff/stat from git-backed service directories.
- Public URL probes and service health checks after deploy.
- Audit and job tables for deploy and rollback actions.

### G. Phase Placement

Insert after Phase 3 actionability and before Phase 8 incident lifecycle. Deploy events improve all later timelines.

### H. Acceptance Criteria

1. A NewsBites deploy hook creates a `deploy_events` row with service, commit SHA, timestamp, result, and health status.
2. A Control Surface restart records a deploy/change event without breaking the live `:3000` service.
3. Time-series charts can request deploy markers for their visible time range.
4. Rollback buttons render only when `rollback_supported=1` and show a preview with previous commit.
5. Failed post-deploy health checks can create or link an incident.

### I. Risks

- Rollback automation is high risk and service-specific; unsupported services must show runbook guidance, not fake one-click rollback.
- Deploy hooks must fail open so a failed dashboard event POST never blocks a production deploy.

## 25. AREA 8: Scheduled Task and Automation Manager

### A. Feature And Stack Value

Add a schedule inventory and manager for systemd timers and dashboard-native scheduled jobs. This matters because model health checks, morning briefs, backups, agent watches, Paperclip notifications, Vast watchdog, scheduled reports, pipeline runs, and health probes all affect the same single-operator day.

### B. User Stories

- As operator, I want to see the next and last run for every systemd timer without opening a shell.
- As operator, I want to pause `newsbites-agent-watch.timer` for a few hours during maintenance.
- As operator, I want to schedule a one-time model health check at 14:00 UTC.
- As operator, I want drift warnings when a timer is not firing at its expected interval.
- As operator, I want warnings when two GPU-heavy scheduled jobs may overlap.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `scheduled_tasks` | `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `task_type TEXT NOT NULL`, `source TEXT NOT NULL`, `schedule_spec TEXT`, `enabled INTEGER NOT NULL`, `next_run_at INTEGER`, `last_run_at INTEGER`, `last_result TEXT`, `uses_gpu INTEGER NOT NULL DEFAULT 0`, `telegram_policy TEXT NOT NULL DEFAULT 'failure_only'`, `metadata_json TEXT`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` | `idx_scheduled_tasks_source(source)`, `idx_scheduled_tasks_next(next_run_at)`, `idx_scheduled_tasks_enabled(enabled)` |
| `scheduled_task_runs` | `id TEXT PRIMARY KEY`, `task_id TEXT NOT NULL`, `scheduled_for INTEGER`, `started_at INTEGER NOT NULL`, `completed_at INTEGER`, `duration_ms INTEGER`, `result TEXT NOT NULL`, `output_summary TEXT`, `job_id TEXT`, `report_id TEXT`, `alert_firing_id TEXT`, `metadata_json TEXT` | `idx_task_runs_task_started(task_id, started_at)`, `idx_task_runs_result(result, started_at)` |
| `one_time_scheduled_runs` | `id TEXT PRIMARY KEY`, `action_type TEXT NOT NULL`, `action_payload_json TEXT NOT NULL`, `run_at INTEGER NOT NULL`, `status TEXT NOT NULL`, `created_by TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `job_id TEXT`, `result_summary TEXT` | `idx_one_time_run_at(run_at, status)` |
| `schedule_conflicts` | `id TEXT PRIMARY KEY`, `detected_at INTEGER NOT NULL`, `task_ids_json TEXT NOT NULL`, `conflict_type TEXT NOT NULL`, `window_start INTEGER`, `window_end INTEGER`, `severity TEXT NOT NULL`, `status TEXT NOT NULL` | `idx_schedule_conflicts_status(status, detected_at)` |

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/schedules/tasks` | `GET` | `?source=&enabled=` | `{ tasks }` | Operator |
| `/api/schedules/tasks/:id/run` | `POST` | `{ reason }` | `{ job, audit_id }` | Operator |
| `/api/schedules/tasks/:id/pause` | `POST` | `{ duration_hours, reason }` | `{ task }` | Admin |
| `/api/schedules/tasks/:id/enable` | `POST` | `{ enabled, reason }` | `{ task }` | Admin |
| `/api/schedules/one-time` | `POST` | `{ action_type, action_payload, run_at }` | `{ run }` | Operator |
| `/api/schedules/runs` | `GET` | `?task_id=&limit=20` | `{ runs }` | Operator |
| `/api/schedules/conflicts` | `GET` | `?status=open` | `{ conflicts }` | Operator |
| `/api/schedules/discover` | `POST` | `{}` | `{ systemdTimers, dashboardJobs }` | Automation |

### E. UI Spec

Infra gets a `Schedules` tab and Settings gets schedule preferences. Each task row/card shows name, next run, last run, last result, schedule spec, enabled state, manual run, pause, history, Telegram policy, and conflicts. Mobile groups tasks by source with last result and next run at the top. One-time scheduled runs use a drawer with UTC date/time input and action preview.

### F. Integration Points

- systemd timers: `model-health-check.timer`, `newsbites-brief.timer`, `morning-brief.timer`, `mimule-backup.timer`, `newsbites-agent-watch.timer`, `paperclip-action-notify.timer`, `vast-watchdog.timer`.
- Dashboard-native scheduled reports, pipeline runs, agent tasks, and health probes.
- Jobs and reports tables for run records.
- Alerting Center for failures, missed runs, drift, conflicts, and backup staleness.
- Mimule/OpenClaw Telegram bridge for opted-in results.

Telegram policy values: `never`, `failure_only`, `success_and_failure`, `critical_only`. Backup, watchdog, and public URL probes default to `failure_only`; morning brief defaults to `success_and_failure` only when explicitly enabled.

### G. Phase Placement

Extend Phase 5 Infra and Phase 2 scheduled reports. Conflict detection should precede more dashboard-native automation.

### H. Acceptance Criteria

1. All listed systemd timers appear with next run, last run, enabled state, and last result.
2. Manual run creates an audited job and appends a run history record.
3. One-time scheduled run executes once and then becomes `completed` or `failed`.
4. Three consecutive intervals deviating by more than 20% create a drift warning.
5. Overlapping GPU-mutex tasks create an open schedule conflict before the overlap window.

### I. Risks

- systemd timer manipulation can disrupt production automation; pause/enable actions require admin auth and audit reason.
- Timezone confusion can cause missed one-time runs; UI must display UTC explicitly everywhere.

## 26. AREA 9: Editorial Intelligence and Content Quality

### A. Feature And Stack Value

Add AI-assisted article quality scoring, source diversity, vertical balance, duplication checks, editorial recommendations, reading level, SEO signals, and freshness decay. This matters because NewsBites output quality and cadence are the business product, and the operator needs strategy signals beyond raw article status.

### B. User Stories

- As operator, I want to know which draft is ready to publish and which needs source or structure work.
- As operator, I want to see if the finance vertical is overusing the same source.
- As operator, I want duplicate-topic warnings before a draft is published.
- As operator, I want a recommendation for what to publish next based on queue, balance, and topic freshness.
- As operator, I want stale fast-moving articles flagged for follow-up.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `article_quality_scores` | `id TEXT PRIMARY KEY`, `article_slug TEXT NOT NULL`, `score_type TEXT NOT NULL`, `score REAL NOT NULL`, `computed_at INTEGER NOT NULL`, `model_used TEXT NOT NULL`, `evidence_json TEXT`, `status TEXT NOT NULL DEFAULT 'current'` | `idx_article_quality_slug(article_slug)`, `idx_article_quality_type_ts(score_type, computed_at)` |
| `article_source_stats` | `id TEXT PRIMARY KEY`, `vertical TEXT NOT NULL`, `source_host TEXT NOT NULL`, `period_start INTEGER NOT NULL`, `period_end INTEGER NOT NULL`, `article_count INTEGER NOT NULL`, `share REAL NOT NULL`, `status TEXT NOT NULL` | `idx_source_stats_vertical_period(vertical, period_end)` |
| `vertical_cadence_targets` | `vertical TEXT PRIMARY KEY`, `min_per_week INTEGER NOT NULL`, `max_per_week INTEGER`, `updated_at INTEGER NOT NULL` | none |
| `content_similarity_checks` | `id TEXT PRIMARY KEY`, `article_slug TEXT NOT NULL`, `compared_article_slug TEXT`, `method TEXT NOT NULL`, `similarity REAL NOT NULL`, `threshold REAL NOT NULL`, `status TEXT NOT NULL`, `computed_at INTEGER NOT NULL`, `evidence_json TEXT` | `idx_similarity_article(article_slug, computed_at)`, `idx_similarity_status(status)` |
| `article_seo_signals` | `id TEXT PRIMARY KEY`, `article_slug TEXT NOT NULL`, `title_length INTEGER`, `meta_description_present INTEGER`, `heading_score REAL`, `keyword_density_json TEXT`, `status TEXT NOT NULL`, `computed_at INTEGER NOT NULL` | `idx_seo_article(article_slug, computed_at)` |
| `editorial_recommendations` | `id TEXT PRIMARY KEY`, `ts INTEGER NOT NULL`, `recommendation_type TEXT NOT NULL`, `title TEXT NOT NULL`, `body TEXT NOT NULL`, `evidence_json TEXT NOT NULL`, `model_used TEXT NOT NULL`, `status TEXT NOT NULL` | `idx_editorial_rec_status(status, ts)` |

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/editorial/quality/:slug` | `GET` | none | `{ scores, seo, similarity, readingLevel }` | Operator |
| `/api/editorial/quality/run` | `POST` | `{ article_slug?, vertical? }` | `{ job }` | Operator |
| `/api/editorial/source-diversity` | `GET` | `?vertical=&days=30` | `{ sources, flags }` | Operator |
| `/api/editorial/vertical-balance` | `GET` | `?days=7` | `{ verticals, targets, gaps }` | Operator |
| `/api/editorial/similarity/check` | `POST` | `{ article_slug }` | `{ checks, status }` | Operator |
| `/api/editorial/recommendations` | `POST` | `{ context?: string }` | `{ recommendations, model_used }` | Operator |
| `/api/editorial/freshness` | `GET` | `?vertical=&older_than_days=` | `{ staleArticles }` | Operator |

### E. UI Spec

Production gets `Quality`, `Sources`, and `Strategy` sections. Article detail drawers show score breakdown, reading level, SEO checks, similarity warnings, source coverage, and "consider follow-up" for stale fast-moving verticals. The Today page can show one editorial recommendation when it affects what to publish next. Mobile presents quality as a compact score card with expandable evidence.

### F. Integration Points

- NewsBites articles under `/opt/newsbites/content/articles`.
- Dossier source files and source URLs from Autopipeline artifacts.
- LiteLLM logical names using free OpenRouter models first for scoring.
- Model health/trending topic files where available.
- Editorial Compliance Report and content provenance lineage from Area 10.
- Alerting for source overuse `>40%`, duplicate threshold breaches, or missed cadence.
- AI Vault logging for recommendation outputs.

### G. Phase Placement

Extend Phase 4 Production Desk after article/dossier status is stable. Duplication checks should run before publish actions become more automated.

### H. Acceptance Criteria

1. A draft or published article can be scored across headline clarity, lead strength, structure, source coverage, reading level, and factual density.
2. Source diversity flags a source used in more than 40% of the last 30 articles in a vertical.
3. Vertical balance shows 7-day counts against configured cadence targets.
4. Similarity check flags overlap above threshold before publishing.
5. Editorial recommendations are logged to AI Vault when generated.

### I. Risks

- AI quality scores can appear authoritative; UI must show score components, model used, and evidence rather than a single unexplained grade.
- Similarity checks using embeddings may require model availability; n-gram fallback must exist through SQLite/local code.

## 27. AREA 10: Content Provenance and Data Lineage

### A. Feature And Stack Value

Add article-level lineage from source documents through dossier stages, model calls, human edits, publish prep, article file, and deployed URL. This matters because AI-generated editorial work must be traceable for quality, compliance, and trust.

### B. User Stories

- As operator, I want to open an article and see which sources and dossier stages produced it.
- As operator, I want to know which logical models contributed to research, write, verify, and publish-prep.
- As operator, I want to compare `draft.md` and `publish.md` to understand human or stage changes.
- As operator, I want citation completeness in the Editorial Compliance Report.
- As operator, I want a broken provenance chain to block or warn on publish.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `content_provenance` | `id TEXT PRIMARY KEY`, `article_slug TEXT NOT NULL`, `stage TEXT NOT NULL`, `model_used TEXT`, `provider TEXT`, `gateway_call_ids_json TEXT`, `sources_json TEXT`, `human_edits_summary TEXT`, `produced_artifact_path TEXT`, `ts INTEGER NOT NULL`, `status TEXT NOT NULL`, `metadata_json TEXT` | `idx_provenance_article_stage(article_slug, stage)`, `idx_provenance_ts(ts)` |
| `article_source_attributions` | `id TEXT PRIMARY KEY`, `article_slug TEXT NOT NULL`, `source_url TEXT NOT NULL`, `source_title TEXT`, `source_type TEXT`, `role TEXT NOT NULL`, `first_seen_stage TEXT`, `evidence_path TEXT`, `created_at INTEGER NOT NULL` | `idx_article_sources_slug(article_slug)`, `idx_article_sources_host(source_url)` |
| `article_edit_diffs` | `id TEXT PRIMARY KEY`, `article_slug TEXT NOT NULL`, `from_artifact_path TEXT NOT NULL`, `to_artifact_path TEXT NOT NULL`, `diff_summary_json TEXT NOT NULL`, `classification_json TEXT NOT NULL`, `computed_at INTEGER NOT NULL` | `idx_article_edit_diffs_slug(article_slug)` |
| `citation_completeness_scores` | `id TEXT PRIMARY KEY`, `article_slug TEXT NOT NULL`, `score REAL NOT NULL`, `source_count INTEGER NOT NULL`, `primary_source_count INTEGER NOT NULL`, `missing_claim_count INTEGER`, `computed_at INTEGER NOT NULL`, `evidence_json TEXT` | `idx_citation_scores_slug(article_slug, computed_at)` |

Provenance chain stages: `source_document`, `dossier.sources.json`, `research`, `DOSSIER.md`, `write`, `draft.md`, `verify`, `publish-prep`, `publish.md`, `article.md`, `deployed_article`.

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/provenance/articles/:slug` | `GET` | none | `{ chain, sources, editDiffs, citationScore }` | Operator |
| `/api/provenance/articles/:slug/rebuild` | `POST` | `{}` | `{ job }` | Operator |
| `/api/provenance/articles/:slug/stages/:stage/artifact` | `GET` | none | Redacted artifact preview | Operator |
| `/api/provenance/articles/:slug/diff` | `GET` | `?from=&to=` | `{ diffSummary, classifications }` | Operator |
| `/api/provenance/source-attribution` | `POST` | `{ article_slug, source_url, role, evidence_path? }` | `{ attribution }` | Operator |

### E. UI Spec

Article detail gets a `Provenance` tab. It renders a vertical chain from sources to deployed article. Each node shows stage, timestamp, model, provider, call IDs, artifact path, source count, and status. Operators can open redacted artifact previews, view edit classifications, and jump to dossier folders. Mobile uses a stepper with one expandable node at a time.

### F. Integration Points

- Autopipeline dossier artifacts and `sources.json`.
- LiteLLM gateway calls and AI run traces.
- NewsBites article markdown and deployed public URL.
- Git history for human edits where available.
- Editorial Compliance Report and quality scoring.
- Sensitive-info redaction before artifact preview/export.

### G. Phase Placement

Extend Phase 4 Production Desk and Phase 8.5 Governance. It should feed the existing Editorial Compliance Report once baseline production entities are stable.

### H. Acceptance Criteria

1. A published article shows a provenance chain from source documents to deployed URL.
2. Each AI-produced stage records logical model, provider, and gateway call IDs when available.
3. Source attribution distinguishes primary and supporting sources.
4. `draft.md` to `publish.md` changes are summarized and classified.
5. Citation completeness score is available to compliance reports.

### I. Risks

- Existing older articles may lack complete artifacts; UI must show partial provenance honestly.
- Artifact previews can expose unpublished content or secrets; all previews need redaction and auth.

## 28. AREA 11: Performance Monitoring and Public URL Health

### A. Feature And Stack Value

Add public URL and internal API performance probes for status, latency, body hash, TLS expiry, uptime, and anomalies. This matters because "service running" is not enough; NewsBites, TIB Markets, Paperclip, Mimule/OpenClaw, Goblin, and Control Surface need public route correctness through Caddy and Cloudflare Tunnel.

### B. User Stories

- As operator, I want to know if `news.techinsiderbytes.com` is slow even when systemd is healthy.
- As operator, I want TLS expiry warnings despite Caddy auto-renewal.
- As operator, I want unexpected body changes flagged when there was no recent deploy.
- As operator, I want p50/p95 latency trends by public URL.
- As operator, I want internal API `/health` latency above 2s to alert before full failure.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `url_probe_targets` | `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `url TEXT NOT NULL`, `target_type TEXT NOT NULL`, `latency_sla_ms INTEGER NOT NULL`, `enabled INTEGER NOT NULL DEFAULT 1`, `expected_status INTEGER NOT NULL DEFAULT 200`, `body_hash_policy TEXT NOT NULL DEFAULT 'learned'`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` | `idx_url_targets_enabled(enabled)`, `idx_url_targets_url(url)` |
| `url_probes` | `id TEXT PRIMARY KEY`, `target_id TEXT NOT NULL`, `url TEXT NOT NULL`, `ts INTEGER NOT NULL`, `status_code INTEGER`, `latency_ms INTEGER`, `body_hash TEXT`, `tls_days_remaining INTEGER`, `error TEXT`, `deploy_event_id TEXT` | `idx_url_probes_target_ts(target_id, ts)`, `idx_url_probes_status(ts, status_code)` |
| `url_uptime_summaries` | `id TEXT PRIMARY KEY`, `target_id TEXT NOT NULL`, `period_start INTEGER NOT NULL`, `period_end INTEGER NOT NULL`, `uptime_pct REAL NOT NULL`, `p50_latency_ms INTEGER`, `p95_latency_ms INTEGER`, `probe_count INTEGER NOT NULL` | `idx_url_uptime_target_period(target_id, period_end)` |
| `url_anomalies` | `id TEXT PRIMARY KEY`, `target_id TEXT NOT NULL`, `ts INTEGER NOT NULL`, `anomaly_type TEXT NOT NULL`, `severity TEXT NOT NULL`, `message TEXT NOT NULL`, `evidence_json TEXT NOT NULL`, `status TEXT NOT NULL`, `alert_firing_id TEXT` | `idx_url_anomalies_status(status, ts)` |

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/url-health/targets` | `GET` | none | `{ targets }` | Operator |
| `/api/url-health/targets` | `POST` | `{ name, url, target_type, latency_sla_ms }` | `{ target }` | Admin |
| `/api/url-health/probes` | `GET` | `?target_id=&from=&to=` | `{ probes }` | Operator |
| `/api/url-health/summary` | `GET` | `?window=7d` | `{ summaries, anomalies }` | Operator |
| `/api/url-health/probe-now` | `POST` | `{ target_id?: string }` | `{ results }` | Operator |
| `/api/url-health/anomalies/:id/ack` | `POST` | `{ note? }` | `{ anomaly }` | Operator |

### E. UI Spec

Infra gets a `Public Health` section. Each URL card shows status, last latency, p50/p95, uptime, TLS days remaining, body hash state, and related deploy marker. Detail drawer shows 7-day latency chart and probe history. Mobile shows critical public URLs first with "probe now" and "create incident" actions.

### F. Integration Points

- Public URLs: `news.techinsiderbytes.com`, `finance.techinsiderbytes.com`, `paperclip.techinsiderbytes.com`, `mimoun.techinsiderbytes.com`, `goblin.techinsiderbytes.com`, `control.techinsiderbytes.com`.
- Internal APIs: Autopipeline `:3200`, Control Surface `:3000/health`, LiteLLM `:4000`.
- Caddy and Cloudflare Tunnel path for public route evidence.
- Deploy events for 10-minute body-hash anomaly suppression after known deploy.
- Alerting Center for latency, non-200, TLS, and body anomalies.

Probe scheduler runs every 3 minutes with `curl` and a 10s timeout.

### G. Phase Placement

Extend Phase 5 Infra and Phase 8 Incident Lifecycle. Public URL probes should exist before SLA-style reliability reports.

### H. Acceptance Criteria

1. Each listed public URL records status, latency, body hash, and TLS days remaining every 3 minutes.
2. Three consecutive non-200 or latency-over-SLA probes create an alertable condition.
3. 7-day uptime percentage and p50/p95 latency are displayed per URL.
4. Body hash changes outside a 10-minute deploy window create a content anomaly.
5. Internal `/health` latency above 2s for Autopipeline, Control Surface, or LiteLLM is visible and alertable.

### I. Risks

- Body hash changes can be normal for dynamic pages; targets need per-URL hash policy and deploy-aware suppression.
- Public probing through Cloudflare can fail differently from localhost checks; both evidence paths should be shown.

## 29. AREA 12: Operator Workspace

### A. Feature And Stack Value

Add the operator's personal workspace layer: pins, notes, tasks, shortcuts, recent items, and notification preferences. This matters because the Control Surface is used as a daily cockpit, and the operator needs lightweight memory separate from formal incidents, jobs, and reports.

### B. User Stories

- As operator, I want to pin the stuck dossier, current incident, and key service to Today.
- As operator, I want to attach a markdown note to an article or incident without creating a formal report.
- As operator, I want a small personal task list linked to stack entities.
- As operator, I want keyboard shortcuts documented and customizable locally.
- As operator, I want alert categories to route to Telegram only when I choose.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `operator_pins` | `id TEXT PRIMARY KEY`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `label TEXT NOT NULL`, `pinned_at INTEGER NOT NULL`, `sort_order INTEGER NOT NULL DEFAULT 0` | `idx_operator_pins_entity(entity_type, entity_id)`, `idx_operator_pins_sort(sort_order, pinned_at)` |
| `operator_notes` | `id TEXT PRIMARY KEY`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `body TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` | `idx_operator_notes_entity(entity_type, entity_id)`, `idx_operator_notes_updated(updated_at)` |
| `operator_notes_fts` | FTS5 virtual table over `body`, content=`operator_notes` | FTS5 index |
| `operator_tasks` | `id TEXT PRIMARY KEY`, `title TEXT NOT NULL`, `body TEXT`, `linked_entity_type TEXT`, `linked_entity_id TEXT`, `due_at INTEGER`, `completed_at INTEGER`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` | `idx_operator_tasks_due(due_at, completed_at)`, `idx_operator_tasks_entity(linked_entity_type, linked_entity_id)` |
| `operator_preferences` | `key TEXT PRIMARY KEY`, `value_json TEXT NOT NULL`, `updated_at INTEGER NOT NULL` | none |

Recent items and shortcut overrides stay in localStorage: `control_surface_recent_entities` and `control_surface_shortcuts`.

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/operator/pins` | `GET` | none | `{ pins }` | Operator |
| `/api/operator/pins` | `POST` | `{ entity_type, entity_id, label }` | `{ pin }` | Operator |
| `/api/operator/pins/:id` | `DELETE` | none | `{ ok: true }` | Operator |
| `/api/operator/notes` | `GET` | `?entity_type=&entity_id=&q=` | `{ notes }` | Operator |
| `/api/operator/notes` | `POST` | `{ entity_type, entity_id, body }` | `{ note }` | Operator |
| `/api/operator/tasks` | `GET` | `?completed=&linked_entity_type=` | `{ tasks }` | Operator |
| `/api/operator/tasks` | `POST` | `{ title, body?, linked_entity_type?, linked_entity_id?, due_at? }` | `{ task }` | Operator |
| `/api/operator/preferences` | `GET` | none | `{ preferences }` | Operator |
| `/api/operator/preferences/:key` | `PUT` | `{ value_json }` | `{ preference }` | Operator |

### E. UI Spec

Today page gets Pinned and My Tasks sections after priorities. Entity detail drawers include pin/unpin and notes. Command palette shows pinned and recent entities. Settings gets Notification Preferences and Keyboard Shortcuts. Mobile supports quick pin from entity overflow menus and task completion from Today without opening a full page.

Shortcut map includes: `g t` Today, `g p` Pipeline, `g m` Models, `g i` Infra, `g a` Agents, `g r` Reports, `g n` Production, `Cmd/Ctrl+K` command palette, `/` search, `?` shortcut reference, `Esc` close drawer, `n t` new task, and `n i` create incident.

### F. Integration Points

- Global search and command palette from Area 5.
- Alert notification preferences from Area 1.
- Any entity with a stable deep link: articles, dossiers, runs, incidents, jobs, policies, reports, agent sessions, services, models, deploys, alerts.
- AI Vault logging for meaningful automated task summaries, not personal note bodies by default.

### G. Phase Placement

Insert after Phase 1 Today and Area 5 search. This improves daily usability without changing service automation.

### H. Acceptance Criteria

1. Any stable entity can be pinned and appears on Today plus command palette.
2. Entity notes are searchable through FTS5 and visible in the entity detail drawer.
3. Personal tasks can be created, linked to an entity, completed, and shown on Today.
4. Recent items are stored in localStorage only and appear in search/command palette.
5. Notification preferences can set categories to in-app only, Telegram only, both, or disabled where allowed.

### I. Risks

- Personal notes can become unofficial operational records; formal incident/report workflows should be suggested when a note contains remediation or outage language.
- localStorage shortcut customization can conflict with browser shortcuts; default map must avoid destructive actions.

## 30. AREA 13: Maintenance Mode and Planned Downtime

### A. Feature And Stack Value

Add planned maintenance windows, checklists, maintenance activation, alert suppression, verification, and AI Vault summaries. This matters because VPS upgrades, secret rotations, migrations, Caddy/Cloudflare changes, and risky service restarts are intentional downtime and should not create false incidents.

### B. User Stories

- As operator, I want to schedule a maintenance window for NewsBites and LiteLLM with an auto-generated checklist.
- As operator, I want probe failures during planned downtime suppressed but still recorded.
- As operator, I want a dashboard banner showing affected services and expected completion.
- As operator, I want post-maintenance checks before marking the work complete.
- As operator, I want the final summary written to AI Vault automatically.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `maintenance_windows` | `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `scheduled_start INTEGER NOT NULL`, `expected_duration_min INTEGER NOT NULL`, `actual_start INTEGER`, `actual_end INTEGER`, `status TEXT NOT NULL`, `affected_services_json TEXT NOT NULL`, `operator_notes TEXT`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`, `ai_vault_log_path TEXT` | `idx_maintenance_status_time(status, scheduled_start)`, `idx_maintenance_window_time(scheduled_start, actual_end)` |
| `maintenance_checklist_items` | `id TEXT PRIMARY KEY`, `window_id TEXT NOT NULL`, `phase TEXT NOT NULL`, `label TEXT NOT NULL`, `required INTEGER NOT NULL DEFAULT 1`, `status TEXT NOT NULL DEFAULT 'pending'`, `confirmed_at INTEGER`, `confirmed_by TEXT`, `evidence_json TEXT` | `idx_maintenance_items_window_phase(window_id, phase)` |
| `maintenance_actions` | `id TEXT PRIMARY KEY`, `window_id TEXT NOT NULL`, `action_type TEXT NOT NULL`, `service TEXT`, `status TEXT NOT NULL`, `started_at INTEGER`, `completed_at INTEGER`, `audit_id TEXT`, `result_json TEXT` | `idx_maintenance_actions_window(window_id)` |
| `maintenance_suppressions` | `id TEXT PRIMARY KEY`, `window_id TEXT NOT NULL`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `starts_at INTEGER NOT NULL`, `ends_at INTEGER NOT NULL` | `idx_maintenance_suppressions_entity_time(entity_type, entity_id, starts_at, ends_at)` |

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/maintenance/windows` | `GET` | `?status=` | `{ windows }` | Operator |
| `/api/maintenance/windows` | `POST` | `{ name, scheduled_start, expected_duration_min, affected_services, notes? }` | `{ window, checklist }` | Admin |
| `/api/maintenance/windows/:id/start` | `POST` | `{ reason }` | `{ window, suppressions }` | Admin |
| `/api/maintenance/windows/:id/items/:itemId` | `POST` | `{ status, note?, evidence? }` | `{ item }` | Operator |
| `/api/maintenance/windows/:id/activate-mode` | `POST` | `{ service, mode: 'caddy_page'|'stop_service' }` | `{ action }` | Admin |
| `/api/maintenance/windows/:id/complete` | `POST` | `{ summary }` | `{ window, ai_vault_log_path }` | Admin |
| `/api/maintenance/active` | `GET` | none | `{ activeWindows }` | Operator |

### E. UI Spec

Infra gets `Maintenance` tab. Active windows show a global dashboard header banner with affected services, expected completion, and checklist progress. Window detail has Pre, During, and Post tabs. Mobile prioritizes checklist confirmations and "extend window" action. Alerts and public probes show "suppressed by maintenance window" labels rather than disappearing.

### F. Integration Points

- Alerting suppression engine from Area 1.
- Public URL probes and service health checks from Area 11.
- Caddy maintenance route or service stop for web-facing services where supported.
- systemd/Docker actions for affected services.
- Backup verification, Autopipeline pause, active agent sessions, Telegram notification, Cloudflare/Caddy readiness.
- AI Vault daily log after completion.

### G. Phase Placement

Extend Phase 5 Infra and Phase 8 Incidents after alerting and public URL probes exist.

### H. Acceptance Criteria

1. Creating a maintenance window generates pre- and post-maintenance checklist items based on affected services.
2. Active maintenance suppresses matching alerts/incidents while still storing probe/log evidence.
3. Dashboard header shows active maintenance status on desktop and mobile.
4. Completion requires required post-checklist items or an explicit audited override.
5. Marking complete writes a summary to `/opt/ai-vault/daily/YYYY-MM-DD.md`.

### I. Risks

- Maintenance suppression can hide real unrelated failures; suppressions must be scoped to affected entities and time windows.
- Caddy maintenance routing can take down the wrong host if templates are too broad; activation needs preview and audit.

## 31. AREA 14: Provider and External Dependency Status

### A. Feature And Stack Value

Add an external dependency registry, connectivity probes, provider status-page ingestion, health matrix, impact analysis, and reliability history. This matters because LiteLLM routing depends on OpenRouter, GitHub Models, Vast.ai, Cloudflare, GitHub, Anthropic quota, and Telegram; their outages are different from local model quality or local service health.

### B. User Stories

- As operator, I want to know if OpenRouter is unreachable before blaming LiteLLM.
- As operator, I want provider outages mapped to affected logical model names.
- As operator, I want GitHub or Cloudflare incidents visible when deploys fail.
- As operator, I want historical provider reliability to inform routing priority.
- As operator, I want Telegram API health checked before enabling alert delivery.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `external_dependencies` | `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `type TEXT NOT NULL`, `endpoint TEXT`, `check_method TEXT NOT NULL`, `auth_required INTEGER NOT NULL DEFAULT 0`, `last_check_ts INTEGER`, `last_status TEXT`, `last_latency_ms INTEGER`, `metadata_json TEXT`, `enabled INTEGER NOT NULL DEFAULT 1` | `idx_external_deps_enabled(enabled)`, `idx_external_deps_type(type)` |
| `external_dependency_checks` | `id TEXT PRIMARY KEY`, `dependency_id TEXT NOT NULL`, `ts INTEGER NOT NULL`, `status TEXT NOT NULL`, `latency_ms INTEGER`, `error TEXT`, `response_summary TEXT` | `idx_dep_checks_dep_ts(dependency_id, ts)`, `idx_dep_checks_status(status, ts)` |
| `provider_status_incidents` | `id TEXT PRIMARY KEY`, `dependency_id TEXT NOT NULL`, `provider_incident_id TEXT`, `title TEXT NOT NULL`, `status TEXT NOT NULL`, `severity TEXT`, `started_at INTEGER`, `updated_at INTEGER`, `url TEXT`, `summary TEXT` | `idx_provider_incidents_dep_status(dependency_id, status)` |
| `dependency_impact_links` | `id TEXT PRIMARY KEY`, `dependency_id TEXT NOT NULL`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `impact_type TEXT NOT NULL`, `created_at INTEGER NOT NULL` | `idx_dependency_impact_dep(dependency_id)`, `idx_dependency_impact_entity(entity_type, entity_id)` |

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/dependencies` | `GET` | `?type=&enabled=` | `{ dependencies }` | Operator |
| `/api/dependencies/:id/checks` | `GET` | `?from=&to=` | `{ checks, uptimePct }` | Operator |
| `/api/dependencies/check-now` | `POST` | `{ dependency_id?: string }` | `{ results }` | Operator |
| `/api/dependencies/:id/impact` | `GET` | none | `{ dependency, affectedEntities }` | Operator |
| `/api/dependencies/status-incidents` | `GET` | `?open=true` | `{ incidents }` | Operator |
| `/api/dependencies/recommend-routing` | `POST` | `{ dependency_id }` | `{ recommendations, model_used }` | Operator |

### E. UI Spec

Models page gets a Provider Health Matrix: provider, last probe, latency, open provider incident, affected logical models, and routing recommendation. Infra has an External Dependencies section for Cloudflare, GitHub, Vast.ai, and Telegram. Mobile uses provider cards with impact chips and "show affected routes."

### F. Integration Points

- LiteLLM config for logical model to provider mapping.
- OpenRouter API/status, GitHub Models/API, Vast.ai API, Cloudflare API, GitHub API, Anthropic API quota endpoint where available, and Telegram API.
- Alerting Center for provider down, quota/auth failure, and sustained latency.
- Cost and fallback tracking for provider-triggered paid fallback.
- Provider status pages where publicly available.

Checks run every 5 minutes and test connectivity, not model output quality.

### G. Phase Placement

Extend Phase 5 Models after LiteLLM logical route inventory exists. It feeds alerting, cost fallback analysis, and model routing recommendations.

### H. Acceptance Criteria

1. Registry contains OpenRouter, GitHub Models, Vast.ai, Cloudflare, GitHub, Anthropic quota, and Telegram.
2. Provider probes run every 5 minutes and store status plus latency.
3. Provider health matrix maps an OpenRouter outage to affected LiteLLM logical models.
4. Open provider status-page incidents appear with source URL where available.
5. 30-day uptime percentage is computed per provider.

### I. Risks

- Provider health endpoints differ and may rate-limit probes; checks must be lightweight and back off.
- Status-page data can lag real outages; local connectivity checks and status-page incidents should be shown separately.

## 32. AREA 15: AI Model Evaluation and Benchmarking

### A. Feature And Stack Value

Add quality evaluation probes, scoring, trends, comparison, quality-informed routing, and regression incidents. This matters because NewsBites and pipeline quality depend not only on whether a model responds, but whether it can research, write, classify, and code with acceptable structure, format, and source behavior.

### B. User Stories

- As operator, I want to know whether a logical editorial model is still producing publishable research/write outputs.
- As operator, I want routing recommendations to consider quality, latency, and cost together.
- As operator, I want to compare two logical models before promoting one in LiteLLM policy.
- As operator, I want model quality regressions to create incidents before bad content reaches publish.
- As operator, I want coding model checks to run a small known task with tests instead of only checking chat response.

### C. Data Model

| Table | Columns | Indices |
|---|---|---|
| `model_eval_definitions` | `id TEXT PRIMARY KEY`, `logical_model TEXT NOT NULL`, `eval_type TEXT NOT NULL`, `prompt_template TEXT NOT NULL`, `scoring_json TEXT NOT NULL`, `enabled INTEGER NOT NULL DEFAULT 1`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` | `idx_model_eval_defs_model(logical_model, enabled)` |
| `model_quality_evals` | `id TEXT PRIMARY KEY`, `model_logical_name TEXT NOT NULL`, `eval_type TEXT NOT NULL`, `score REAL NOT NULL`, `ts INTEGER NOT NULL`, `raw_output_preview TEXT`, `latency_ms INTEGER`, `cost_cents REAL`, `format_ok INTEGER`, `checks_json TEXT NOT NULL`, `gateway_call_id TEXT`, `model_used_for_judge TEXT` | `idx_model_quality_model_ts(model_logical_name, ts)`, `idx_model_quality_eval_type(eval_type, ts)` |
| `model_quality_regressions` | `id TEXT PRIMARY KEY`, `model_logical_name TEXT NOT NULL`, `eval_type TEXT NOT NULL`, `detected_at INTEGER NOT NULL`, `baseline_score REAL NOT NULL`, `current_score REAL NOT NULL`, `drop_pct REAL NOT NULL`, `status TEXT NOT NULL`, `alert_firing_id TEXT`, `incident_id TEXT` | `idx_model_regressions_status(status, detected_at)` |
| `model_comparison_runs` | `id TEXT PRIMARY KEY`, `left_model TEXT NOT NULL`, `right_model TEXT NOT NULL`, `eval_types_json TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `result_json TEXT NOT NULL`, `recommendation TEXT` | `idx_model_comparisons_created(created_at)` |

### D. API Surface

| Endpoint | Method | Request | Response | Auth |
|---|---|---|---|---|
| `/api/models/evals/definitions` | `GET` | `?logical_model=` | `{ definitions }` | Operator |
| `/api/models/evals/run` | `POST` | `{ logical_model?, eval_type? }` | `{ job }` | Operator |
| `/api/models/evals/results` | `GET` | `?logical_model=&eval_type=&from=&to=` | `{ results, trends }` | Operator |
| `/api/models/evals/compare` | `POST` | `{ left_model, right_model, eval_types }` | `{ comparison }` | Operator |
| `/api/models/evals/regressions` | `GET` | `?status=open` | `{ regressions }` | Operator |
| `/api/models/evals/update-health-file` | `POST` | `{ logical_model }` | `{ wrote: true, path: '/var/lib/mimule/model-health.json' }` | Automation |

### E. UI Spec

Models page gets a `Quality` tab. Each logical model card shows 7-day quality trend, latest editorial/routing/coding evals, format compliance, cost, latency, and routing recommendation. Comparison drawer shows side-by-side score, latency, cost, and failed checks. Mobile shows one logical model at a time with trend sparkline and "run eval" action.

### F. Integration Points

- LiteLLM logical model names only; no hardcoded provider backends.
- Free OpenRouter models first for judging/evaluation where AI judging is needed.
- `/var/lib/mimule/model-health.json` extended with `quality_score`.
- Existing model-health-check service for scheduling and file write path.
- Cost events, provider status, alerting, incidents, and AI Vault logging.

Evaluation probes:

| Tier | Probe | Checks |
|---|---|---|
| Editorial | Standard research prompt and write prompt | Word count, structure, citation presence, factual plausibility heuristic, refusal/hallucination markers. |
| Routing/triage | Classification prompt | Correct category, response format, latency. |
| Coding | Small known coding task | Syntax validity and known-case tests. |

### G. Phase Placement

Extend Phase 5 Models after health and provider inventory. Regression incidents require Area 1 alerting and Phase 8 incident lifecycle.

### H. Acceptance Criteria

1. Each enabled logical model can run editorial, routing, or coding quality evals appropriate to its tier.
2. `model_quality_evals` stores score, eval type, timestamp, preview, latency, cost, checks, and gateway call ID.
3. Models page shows 7-day quality trend and flags drops greater than 20% from the 7-day average.
4. Model comparison displays quality, latency, and cost side by side for two logical names.
5. `/var/lib/mimule/model-health.json` includes a `quality_score` without removing existing health fields.

### I. Risks

- AI-as-judge can reinforce bad scoring; deterministic checks and visible raw previews must anchor every score.
- Eval probes can spend money if routed poorly; they must use free logical routes first and respect budget limits.

## 33. Priority Ordering For The 15 New Areas

1. Alerting and Notification Center.
2. Performance Monitoring and Public URL Health.
3. Unified Log Aggregation and Search.
4. Deployment Tracking and Change History.
5. Scheduled Task and Automation Manager.
6. Cost, Budget, and Spend Management.
7. Cost and Capacity Trend Analysis.
8. Provider and External Dependency Status.
9. Global Search and Command Palette.
10. Maintenance Mode and Planned Downtime.
11. Secrets and Credential Management.
12. AI Model Evaluation and Benchmarking.
13. Content Provenance and Data Lineage.
14. Editorial Intelligence and Content Quality.
15. Operator Workspace.

Rationale: first make the operator aware of production-impacting failures, then make incidents explainable with logs/deploys/schedules, then control spend/capacity/provider risk, then improve navigation, maintenance, security inventory, model quality, and editorial intelligence.

## 34. Phase Placement Map

| Area | Placement |
|---|---|
| Area 1 Alerting | New Phase 1.5 before reports and incident expansion. |
| Area 2 Cost/Budget | Extends Phase 5 Models; feeds Phase 2 Model Reliability and Cost Report. |
| Area 3 Secrets/Credentials | Extends Phase 8.5 Governance. |
| Area 4 Capacity Trends | Extends Phase 5 Infra and Phase 9 performance. |
| Area 5 Search/Command Palette | New Phase 3.5 after actionability and before production/model depth. |
| Area 6 Logs | Extends Phase 5 Infra and Phase 8 Incidents. |
| Area 7 Deploys | New Phase 3.6 after action engine and before incident correlation. |
| Area 8 Schedules | Extends Phase 5 Infra and Phase 2 scheduled reports. |
| Area 9 Editorial Intelligence | Extends Phase 4 Production Desk. |
| Area 10 Provenance | Extends Phase 4 Production Desk and Phase 8.5 Governance. |
| Area 11 URL Performance | Extends Phase 5 Infra and Phase 8 Incidents. |
| Area 12 Operator Workspace | New Phase 1.6 after Today and before broad entity expansion. |
| Area 13 Maintenance | Extends Phase 5 Infra and Phase 8 Incidents. |
| Area 14 Provider Status | Extends Phase 5 Models. |
| Area 15 Model Evaluation | Extends Phase 5 Models and Phase 8 Incidents. |

## 35. Cross-Area Dependencies To Resolve First

1. Alerting Center must exist before budget, capacity, public URL, provider, schedule, and model quality alerts can fire consistently.
2. Stable entity IDs and deep links must exist before search, pins, notes, incidents, deploy annotations, provenance, and log links are reliable.
3. LiteLLM call tracing must propagate logical model, provider, workflow, article, dossier, Builder run, and gateway call IDs before cost attribution and model evaluation are trustworthy.
4. Log redaction and sensitive-info linkage must exist before log export, credential health, AI summaries, and incident evidence bundles are safe.
5. Deploy event ingestion must exist before body-hash anomalies, latency regressions, capacity jumps, and provider/model incidents can be correlated accurately with changes.

## 36. Open Decisions For This Scope

- Decide whether alert rules are edited only through templates in the first release or whether custom JSON conditions are exposed to the operator.
- Decide the initial Telegram rate limit: proposed default is at most one message per dedupe key per 30 minutes, with `page` severity allowed one re-ping after 30 minutes.
- Confirm the canonical paths for NewsBites, TIB Markets, dashboard, dossier root, Builder run root, and AI Vault before implementing scanners.
- Choose the first SQLite FTS strategy shared by search, notes, and logs so tokenizer and migration patterns are consistent.
- Decide which services can support automated rollback in v1; all others should show runbook-only rollback guidance.
- Define Autopipeline operating hours for the "no article published in >18 hours" alert.
- Define per-vertical cadence targets for editorial balance.
- Decide whether model quality eval raw previews are retained for 30 days or summarized sooner for storage/privacy.
- Confirm which provider status pages are reliable enough to poll versus local-only connectivity checks.
- Decide the first maintenance-mode mechanism per host: Caddy maintenance route, service stop, or read-only banner.

---

## 37. Brainstormer — Strategic Planning Studio

### 37.1 Problem Statement

There is no structured path from "I have an idea" to "I have a plan that a coding agent can execute." The Builder runs plan files but there is no tool to **create** good plan files. The operator is forced to write plan files manually in an external editor, without awareness of what already exists, what is already in progress, what has been tried, or what the codebase looks like. This results in:

- Duplicate implementation of things that already exist.
- Plans that conflict with in-progress Builder runs.
- Plans that reference wrong file paths or nonexistent commands.
- Plans that are too vague for agents to execute without extensive back-and-forth.
- Plans that miss known risks or constraints (GPU availability, disk space, live service impact).

### 37.2 Solution: Brainstormer Page

Add a new **Brainstormer** page at `/brainstorm`. This is a purpose-built workspace where the operator describes what they want to achieve, and the AI does all the research, context-loading, conflict-checking, and plan drafting before a single line of code is written.

The Brainstormer is NOT a chat page. It is a structured, multi-phase planning workflow that produces a coding-agent-ready plan file as its artifact.

### 37.3 Brainstormer Page UX

#### Input Phase

The operator provides:

- **Goal** (required): Free-text description of what to build, fix, improve, or investigate.
- **Target project** (optional, picker): Which project the work targets. If left blank, AI infers from goal.
- **Urgency** (optional, selector): `exploration` / `planned` / `urgent` / `critical`. Affects how conservative the plan is.
- **Mode** (optional, selector):
  - `build` — New feature or capability.
  - `fix` — Bug or regression.
  - `refactor` — Structural improvement without new behavior.
  - `investigate` — Research-only, no code changes.
  - `secure` — Security audit or hardening.
  - `document` — Documentation generation.
  - `test` — Test coverage improvement.
- **Constraints** (optional, multi-select chips): `never touch live DB`, `read-only`, `no new dependencies`, `mobile-first`, `reuse existing components`, `no breaking API changes`.

No file path typing. No manual service name entry. All selections are from discovered, live entities.

#### Research Phase (AI-driven, visible to operator)

After the operator submits the goal, the AI runs a structured research flow. The operator sees progress in real time (SSE-backed):

1. **Codebase Scan**
   - Find files, directories, and modules relevant to the goal.
   - Identify existing implementations that overlap with the goal.
   - Identify patterns used in similar areas of the codebase.

2. **Plan File Discovery**
   - Search all `*PLAN*.md` files in `/root`, `/opt/opencode-control-surface`, and detected project roots.
   - Identify any in-progress plans that conflict with or relate to the goal.
   - Flag items already covered by other plans.

3. **AI Vault Context**
   - Search AI Vault daily logs for sessions related to the goal area.
   - Extract decisions, blockers, and conclusions from previous sessions.
   - Identify what was tried before and what did or did not work.

4. **Builder Run History**
   - Check recent Builder runs targeting the same project.
   - Identify partially completed work and uncommitted plan items.
   - Surface any `PASS_RESULT.json` entries with `status: blocked`.

5. **Stack Impact Analysis**
   - Identify which live services, timers, and containers the goal may affect.
   - Identify files that belong to live services and must not be broken.
   - Identify required services for validation (e.g., if validating NewsBites, service must be up).

6. **Dependency and Risk Check**
   - Identify external APIs, LiteLLM models, and GPU that the work may depend on.
   - Check current availability and health of those dependencies.
   - Flag if GPU is down, a model is degraded, or disk is at risk.

7. **Conflict Check**
   - Detect active Builder runs on the same project root.
   - Detect any in-progress workflow that writes to overlapping files.
   - Warn if uncommitted changes exist in the target project.

Each research step emits findings cards. The operator can expand each finding, skip it, or mark it as already-known.

#### Analysis Phase (AI-generated, operator-reviewed)

After research, the AI generates a structured pre-plan analysis:

- **What already exists** — components, APIs, DB tables, UI pages, styles, that can be reused.
- **What conflicts** — things already in progress or planned that this work would conflict with.
- **What is risky** — live services, active data, shared infrastructure, low disk, absent GPU.
- **What is missing** — knowledge gaps, missing documentation, unclear requirements.
- **Recommended scope** — what the AI recommends including and excluding based on the research.
- **Estimated passes** — rough estimate of how many Builder passes this work will take.
- **Recommended model** — which agent and model the AI recommends for this task type.

The operator can edit any of these before proceeding.

#### Planning Phase (AI-generated, operator-edited)

The AI generates a full, coding-agent-ready plan document. The plan uses the Agent-Friendly contract from `AGENT_FRIENDLY_6_MONTH_PLAN.md`:

```markdown
# Plan: [Goal Title]

Generated: [ISO timestamp]
Target Project: [detected project root]
Mode: [build|fix|refactor|investigate|secure|document|test]
Urgency: [exploration|planned|urgent|critical]
Recommended Agent: [claude|codex|opencode|gemini]
Recommended Model: [logical model name]
Estimated Passes: [N]

## Context

[What already exists that is relevant.]
[What conflicts were detected.]
[What the AI Vault says about prior work in this area.]

## Scope

### In scope
- [item]

### Out of scope
- [item]

## Constraints

- [Never touch X without checking Y first.]
- [Run bun typecheck after every file edit.]

## Pre-Implementation Checklist

- [x] Confirm service is running at [port] before starting.
- [x] Check disk has > 2GB free.
- [x] Check no active Builder runs target this project.
- [x] Read [specific file] to understand current implementation.

## Implementation Steps

### Step 1: [Name]

Files to read: [paths]
Files to edit: [paths]
Files to create: [paths]
Commands: [commands]

Subtasks:
- [ ] [Specific subtask with file + line reference]

Validation after this step:
- Run: [command]
- Expected: [expected output]

### Step 2: [Name]
...

## Validation Profile

Typecheck: `bun run typecheck`
Tests: `bun test [specific test file]`
Playwright: [url] — [specific flows to verify]
Build: `bun run build`

## Rollback Plan

If step N fails: [specific rollback steps]
Safe state: [description of known-good state]

## Acceptance Criteria

- [ ] [Specific, measurable outcome]

## PASS_RESULT Protocol

Write `$BUILDER_DIR/PASS_RESULT.json` before exiting each pass.
```

The operator can edit any section inline before saving. The Brainstormer provides inline AI assistance for each section ("suggest better acceptance criteria", "expand the rollback plan", "add validation for this step").

#### Review Phase

The operator reviews the full plan in a split view:

- Left: the editable plan document.
- Right: the research findings for context.

The AI runs a final plan validation pass:
- Check all referenced file paths exist.
- Check all referenced commands are available (`which [command]`).
- Check all referenced services are in the known service list.
- Flag any acceptance criteria that are unmeasurable.
- Flag any steps that have no validation.
- Flag any steps that touch live production files without a rollback.

#### Commit Phase

When the operator approves the plan:

1. The plan file is saved to the target project root (or a configurable plan directory).
2. The plan is registered in the dashboard plan registry.
3. The Builder page is notified of the new plan (via an SSE event or refresh).
4. The Brainstormer shows a "Start Builder Workflow" button that pre-fills a new workflow form pointing to the saved plan.
5. The plan is logged to the AI Vault.

### 37.4 Plan Auto-Detection by Builder

The Builder should continuously scan for new plan files:

- Scan `$PROJECT_ROOT/*.md`, `$PROJECT_ROOT/plans/*.md`, `$PROJECT_ROOT/docs/*.md` on project registration and every 15 minutes.
- Detect plans that have unchecked `- [ ]` items.
- Detect plans that have `PASS_RESULT.json` with `status: blocked` or `status: incomplete` (from a previous Builder run that ended without completion).
- Classify each plan as `new`, `in_progress`, `blocked`, or `complete`.
- Surface detected plans on the Builder page as "Detected Plan Files" with status and a "Create Workflow" action.

Auto-detection should also scan:
- `/root/*PLAN*.md`
- `/opt/opencode-control-surface/*.md`
- `/opt/newsbites/*.md`
- `/opt/mimoun/*.md`
- `/opt/paperclip/*.md`

### 37.5 Brainstormer → Builder Direct Integration

After a Brainstormer session produces a plan:

1. The "Start Builder Workflow" button opens the Builder workflow creation form.
2. The form is pre-filled with:
   - Plan file path (the saved plan).
   - Project root (detected during research).
   - Recommended agent and model.
   - Validation profile (detected from the project's package.json/go.mod/cargo.toml).
   - Risk policy (inferred from urgency and live-service impact).
3. The operator reviews and adjusts, then starts the workflow.
4. The Brainstormer session is linked to the Builder run for traceability.

### 37.6 Brainstormer API Surface

```
POST /api/brainstorm/sessions          — Create a new session
GET  /api/brainstorm/sessions          — List sessions
GET  /api/brainstorm/sessions/:id      — Get session (goal, research findings, analysis, plan draft)
POST /api/brainstorm/sessions/:id/research — Trigger research phase
GET  /api/brainstorm/sessions/:id/stream   — SSE stream for research progress
POST /api/brainstorm/sessions/:id/generate-plan — Trigger plan generation
POST /api/brainstorm/sessions/:id/validate-plan  — Run plan validation
POST /api/brainstorm/sessions/:id/save-plan      — Save plan file and register
POST /api/brainstorm/sessions/:id/to-builder     — Pre-fill Builder workflow creation
GET  /api/builder/detected-plans                 — List auto-detected plan files across projects
```

### 37.7 Phase Placement

Add Brainstormer as **Phase 7.5** immediately after Builder as Repeatable Work System (Phase 7). The Builder must be stable before Brainstormer adds the upstream planning layer.

---

## 38. Settings Page — Full Control Inventory

### 38.1 The Problem

The current Settings page has three tabs: Auth & Stack (read-only status), License (read-only), and Telemetry (consent). It provides zero actionable controls for the operator. Settings should be the single place where the operator configures how the entire stack behaves, without needing to edit config files or environment variables directly.

### 38.2 Required Settings Sections

#### Operator Profile

- Display name (editable).
- Timezone (picker — affects all timestamp displays and scheduled report times).
- Preferred date format and locale.
- Dashboard density preference: `comfortable` / `compact` / `ultra-compact`.
- Theme: `auto` / `light` / `dark`.
- Default report period (7 days / 30 days / custom).
- "What I care about first" preference: `production` / `pipeline` / `models` / `infra` / `agents`.

#### Authentication and Session

- Current session state and expiry.
- API token display (last 4 chars), rotation action.
- Session timeout configuration.
- Failed auth attempt log (last 10).
- Trusted device list (if Cloudflare Zero Trust headers used).
- IP allowlist management.
- MFA readiness indicator (with setup guidance).
- Cloudflare Access state (header presence, JWKS validation status).

#### Stack Configuration

- Canonical paths for key directories (with filesystem-picker, not manual typing):
  - NewsBites content root.
  - Dossier root.
  - AI Vault root.
  - Builder run directory.
  - Backup directory.
- Live service URL overrides (if ports change).
- Autopipeline endpoint (default: `http://127.0.0.1:3200`).
- LiteLLM endpoint (default: `http://127.0.0.1:4000`).
- Ollama/Vast tunnel endpoint.
- Vast.ai SSH config (host, port, key path — path picker, not text field).
- Git user configuration display.
- Caddy config path.
- Cloudflare tunnel service name.

#### Pipeline and Editorial Preferences

- Auto-publish verticals: multi-select from known verticals (`ai`, `finance`, `trends`, etc.).
- Max concurrent pipeline items (slider: 1–10).
- Retry policy for failed stages: `off` / `once` / `twice` / `with_backoff`.
- Stage timeout overrides per stage type (sliders with sensible defaults and max limits).
- Source blacklist/whitelist (editable list, not manual YAML).
- Minimum source coverage threshold before approve-for-publish (slider: 0–5 sources).
- Stale dossier threshold (after N hours without progress, mark as stale): slider.
- Per-vertical article cadence targets (articles per day, 0 = unlimited).
- Auto-queue topics from morning brief: `on` / `off`.

#### Model and AI Preferences

- Default model for each task type (dropdowns populated from LiteLLM config logical names):
  - Research tasks.
  - Writing tasks.
  - Verification tasks.
  - Code tasks (heavy).
  - Code tasks (fast).
  - Routing decisions.
  - Telegram bot.
- Model preference for new Builder workflows (default agent + model).
- Maximum cloud spend per day (hard cap): currency input with alert threshold.
- Cloud-first vs GPU-first preference (slider: 0% cloud = always GPU, 100% cloud = always cloud).
- Auto-fallback to cloud when GPU unavailable: `on` / `off`.
- Model quality threshold below which routing demotes a provider (score picker).
- Model health check frequency (dropdown: 1h / 2h / 5h / 12h / manual only).

#### Alert and Notification Preferences

- Telegram notification channel: enabled / disabled / summary only.
- Per-severity Telegram routing:
  - `info`: app-only / telegram / off.
  - `warning`: app-only / telegram / off.
  - `critical`: app + telegram / telegram only / app only / off.
  - `page`: always send + re-ping after 30min.
- Telegram rate limit: minimum minutes between messages per dedupe key.
- Quiet hours: time range during which only `page` severity alerts send to Telegram.
- Alert template overrides (Telegram message format per severity).
- Morning brief time (time picker, UTC).
- Morning brief content toggles: pipeline / models / infra / agent work / incidents / articles published.

#### Builder Preferences

- Default max passes per workflow (slider: 1–20, default 10).
- Default stall warn timeout (slider: 60–600s).
- Default stall kill timeout (slider: 120–1800s).
- Default validation profile selection for new workflows.
- Auto-continue on `incomplete` status: `on` / `off` (can be overridden per workflow).
- PASS_RESULT.json synthesis fallback (if agent exits without writing result): `on` / `off`.
- Tmux session cleanup delay after pass completion (slider: 0–300s).
- Artifact retention for completed runs (dropdown: 7d / 14d / 30d / 90d / forever).
- Auto-log completed Builder runs to AI Vault: `always` / `ask` / `never`.

#### Infra and Service Preferences

- Service restart confirmation mode per service: `always confirm` / `confirm if live` / `auto if low risk`.
- Disk usage warning threshold (slider: 50–90%).
- Disk usage critical threshold (slider: 75–95%).
- RAM usage critical threshold.
- Backup verification: automatic after backup + frequency of manual verification.
- Backup retention count (slider: 3–30).
- Auto-create incident on service restart failure: `on` / `off`.
- Vast.ai runway warning threshold (hours before low-balance alert).

#### AI Vault Preferences

- Auto-log sessions to AI Vault: configure which session types auto-log.
- Default project file for each stack area.
- Vault log format: `short` / `full` / `structured`.

#### Danger Zone

- Clear all alert suppressions.
- Reset all notification preferences to defaults.
- Export all settings as JSON.
- Import settings from JSON (with diff preview before applying).

### 38.3 Settings Are Live-Persisted

Every settings change:
- Is persisted immediately to the `operator_settings` table (not a config file that requires restart).
- Is written to the audit log with before/after values.
- Takes effect on the next evaluation cycle (alerts, reports, routing) without a service restart.
- Can be reverted from the audit log.

### 38.4 Settings Page UX

- Grouped into collapsible sections with clear headings.
- No text fields for things that have known options.
- No text fields for file paths — use a file-browser picker backed by `/api/fs/browse`.
- All sliders show current value, minimum, maximum, and recommended default.
- Dropdowns show current value clearly.
- Changes show a confirmation indicator ("saved") inline — no full-page save button.
- Dangerous settings (danger zone) have a separate confirmation step.
- Mobile: sections collapse by default; only the active section is expanded.

---

## 39. Zero-Typing GUI Policy

### 39.1 The Problem

The current dashboard violates a fundamental principle: the operator should never need to type a filesystem path, a service name, a model name, a vertical name, or any value that is already known to the system. Typing introduces errors, requires memorization, and is hostile on mobile. Every text field that accepts a known-universe value should be replaced with a picker, autocomplete, or dropdown.

### 39.2 Zero-Typing Inventory

The following inputs must be eliminated or replaced:

#### File Path Inputs

- Builder workflow "plan file path" → filesystem browser picker backed by `/api/fs/browse` that shows plan-looking files first.
- Builder workflow "project root" → detected project selector with icons and descriptions.
- Dossier "inject at stage" → dossier browser showing actual directories.
- Settings "Vast SSH key path" → filesystem browser filtered to `~/.ssh/`.
- AI Vault log path → picker showing known vault structure.

Implementation: `/api/fs/browse?path=&filter=&type=` returns directory listings. Never expose full filesystem — restrict to known safe roots (`/opt/`, `/root/`, `/etc/litellm/`, `/var/lib/mimule/`, `~/.ssh/`).

#### Service and Container Name Inputs

All service/container name inputs → autocomplete from discovered service list. Populated from `/api/infra/services`.

#### Model Name Inputs

All model name inputs → dropdown from LiteLLM logical names. Populated from `/api/models`. Never type a model ID.

#### Vertical Name Inputs

All vertical/category inputs in pipeline add-topic → chip-selector from known verticals list. Never type a vertical slug.

#### Topic and Tag Inputs

Add-topic forms → tag-style chips for verticals. Source notes → structured source picker from previously used sources.

#### Agent Name Inputs

All agent selection → icon-picker showing Claude, Codex, OpenCode, Gemini, Aider with capability badges.

#### Time and Duration Inputs

All duration inputs → sliders or time-pickers. Never require typing "300s" or "5m".

#### Priority Inputs

All priority inputs → visual 1–5 priority selector with labels (routine / normal / elevated / high / critical).

#### Validation Command Inputs

Builder validation commands → dropdown from detected project commands (`bun run check`, `go test ./...`, `cargo check`, etc., populated from package.json/go.mod/Makefile parsing).

#### Workflow Template Selection

New workflow creation → template gallery showing pre-built workflow types (NewsBites feature slice, Dashboard slice, Mimule fix, Pipeline ops task, Infra ops task) with descriptions. Operator picks template, then fills in minimal details.

### 39.3 Smart Defaults

Every form should be pre-filled with intelligent defaults based on context:

- If the operator is on the Production page when clicking "Add to Pipeline", the form should pre-select the vertical of the article they were viewing.
- If the operator is on the Builder page when clicking "New Workflow", the form should pre-select the last-used project.
- If the operator clicks "Inject Dossier" on a pipeline item row, the dossier path should be pre-filled from the item's known dossier path.
- If the operator clicks "Create Workflow from Conversation" on an agent page, the project root should be pre-filled from the files the agent touched in the conversation.

### 39.4 Contextual Pre-Fill API

Add a server-side pre-fill inference API:

```
POST /api/prefill/workflow-form    — Returns suggested workflow form values given context
POST /api/prefill/pipeline-form    — Returns suggested add-topic values given page context
POST /api/prefill/incident-form    — Returns suggested incident fields from triggering event
POST /api/prefill/report-form      — Returns suggested report parameters
```

Each endpoint accepts a `context` object describing where the user is and what they were looking at, and returns confident + low-confidence suggestions labeled as such.

---

## 40. AI Auto-Detection, Digestion, and Explanation Engine

### 40.1 The Problem

The operator should not need to configure the dashboard from scratch, annotate every service manually, understand every error message, or explain every log excerpt to the system. The AI should continuously detect, digest, and explain everything — then present conclusions, not raw data.

### 40.2 Auto-Detection Domains

The following must be auto-detected without manual configuration:

#### Services and Processes

- All systemd services (`systemctl list-units --type=service --all`).
- All Docker containers and their status.
- All exposed ports and which process owns them.
- All Caddy virtual hosts from the Caddyfile.
- All public-facing URLs and their expected health endpoints.
- All cron jobs and timers and their schedules.
- All Cloudflare tunnel routes from cloudflared config.

#### Projects and Codebases

- All directories under `/opt/` with a `package.json`, `go.mod`, `cargo.toml`, `requirements.txt`, or `Makefile`.
- All systemd unit files and which directories they reference.
- All Docker compose files and which images/containers they define.
- All git repositories and their remotes.
- All plan files (`*PLAN*.md`) and their completion state.
- All dossier directories under the editorial pipeline root.
- All article files and their frontmatter state.

#### Models and Providers

- All models defined in `/etc/litellm/config.yaml`.
- Current health and latency from `/var/lib/mimule/model-health.json`.
- Rate-limit events from LiteLLM logs.
- Cost signals from gateway call logs.

#### Agent Work

- Active tmux sessions and which Builder runs they belong to.
- Builder run dirs under `/var/lib/control-surface/builder-runs/`.
- AI Vault logs and their completeness.
- Last agent work per project (from git log if available).

#### Capacity and Resources

- Disk usage per mount.
- RAM usage and swap state.
- CPU load (1m/5m/15m averages).
- Vast.ai balance from state file or direct API (if key available).
- GPU tunnel connectivity and current model load.
- Backup directories and last backup timestamp.

### 40.3 AI Digestion — What the AI Should Explain Without Being Asked

Every detected entity should be automatically explained. The AI should produce, on first detection and on refresh:

- **Service explanation**: "This is `newsbites.service`. It runs the NewsBites Next.js frontend at news.techinsiderbytes.com on port 3001. It was last restarted N hours ago. Current response time from internal probe is N ms."
- **Error explanation**: "Exit code 143 means the process received SIGTERM — typically an OOM kill or external shutdown. Check if RAM exceeded 8GB (current: 7.1GB). Previous exit at 02:14 UTC had the same code."
- **Model routing explanation**: "The router selected `editorial-cloud-heavy` instead of the local `editorial-heavy` because the Vast tunnel has been unavailable for 47 minutes. Cloud fallback chain used: nemotron → github-gpt41."
- **LiteLLM config explanation**: "This timeout of 600s applies to the full round-trip including streaming. If a model produces no tokens for 600s, the request fails. This is appropriate for long research tasks but would cause silent delays if lowered."
- **Dossier status explanation**: "This dossier has been in the `write` stage for 6 hours with no progress event. The last recorded activity was a failed `editorial-cloud-heavy` call that returned a 503. The queue item is likely stuck."

### 40.4 Conversational Query Interface

Add an operator query bar (Cmd+K or floating bottom input on mobile) that answers natural language questions over dashboard data:

Examples:
- "How many articles were published this week?" → queries article metadata.
- "Which model is failing most often?" → queries gateway_calls error rates.
- "Why is the pipeline stuck?" → reads queue state, last stage event, last model error.
- "What changed in the last hour?" → reads audit log, job completions, alerts fired.
- "How long until my GPU bill exceeds $50?" → reads Vast.ai balance and current cost rate.
- "What should I do right now?" → generates a priority list from all sources.

The query bar is backed by the same AI assistance infrastructure as the AI call trace system. Responses cite their sources (table name, entity ID, timestamp). Responses include action suggestions.

This is NOT a general chat interface. It is a structured query layer over the dashboard's own data. The AI cannot make external calls from this interface.

### 40.5 AI Digest Scheduler

The system runs periodic AI digest passes:

| Digest | Frequency | Content |
|---|---|---|
| Stack health summary | Every 15 minutes | Service state, model state, queue depth, GPU, disk. |
| Error cluster digest | Every 30 minutes | Group errors by pattern, name likely causes, surface in incidents. |
| Daily editorial brief | Every morning at 07:00 UTC | Articles published, verticals covered, pipeline state, stale dossiers. |
| Model quality digest | After every model health check | Which models improved, which degraded, new models discovered. |
| Agent work digest | After every Builder run completes | What changed, what validated, what is next. |
| Cost digest | Daily | Spend by provider, by model, by project. |

Digests are stored as structured objects and surfaced on the Today page, Reports, and via Telegram if opted in.

### 40.6 "Explain This" Action

Every error, warning, log excerpt, metric, incident, model status, service event, queue item, dossier state, and agent run must have an **Explain This** action — a single-tap button that sends the item's context to the AI and returns a plain-language explanation with likely cause, impact, and recommended next step.

The AI call for Explain This:
- Uses the `routing-cheap` model for fast responses (< 2s).
- Is cached by entity + state hash for 5 minutes.
- Is logged to the AI call trace.
- Never invents information — only explains what is in the attached evidence.
- Always includes: what happened, why it likely happened, what the impact is, what to do next.

---

## 41. Security Control Plane

### 41.1 Authentication Hardening

Current state: bearer token with no expiry, no rotation, no audit, no MFA.

Required additions:

- **Session expiry**: Tokens expire after a configurable time (default: 7 days). On expiry, re-authentication is required.
- **Token rotation**: Operator can rotate the token from Settings. Old token is invalidated immediately.
- **Failed auth logging**: All failed auth attempts logged to `auth_events` table with timestamp, IP, user-agent.
- **Auth event alerts**: More than 5 failed attempts in 10 minutes triggers a critical alert.
- **Cloudflare header verification**: Verify Cloudflare JWT signature using JWKS (not just header presence check).
- **IP binding**: Option to restrict sessions to the originating IP (useful for desktop sessions, must be opt-in due to mobile IP changes).
- **MFA readiness**: UI indicator showing MFA is not yet configured, with setup guidance (TOTP via Cloudflare Access or local TOTP).

### 41.2 Authorization and Role-Based Access

Current state: single token, full access to everything.

Required roles (start with two, expand later):

| Role | Capabilities |
|---|---|
| `viewer` | Read all pages. No actions. No config changes. |
| `operator` | Read all pages. Run safe actions. Approve pipeline items. Generate reports. |
| `engineer` | All operator capabilities. Manage Builder workflows. Modify model routing. |
| `admin` | All engineer capabilities. Change settings. Rotate tokens. Manage policies. |
| `automation` | Run Builder passes. Emit events. No UI access. |

Every API endpoint must have an `@requires(role)` annotation. Missing role checks are a security defect.

Per-page visibility matrix:
- Sensitive pages (Governance, Secrets, Audit, Settings) require `admin` role.
- Destructive actions (live service restart, pipeline kill, model block) require `operator` role minimum plus confirmation.
- Read pages require `viewer` minimum.

Role is encoded in the token or derived from Cloudflare Access claims. The RBAC middleware checks at the API layer, not the UI layer — hiding a button is not sufficient.

### 41.3 Secrets and Credential Management UI

Current state: secrets live in `.env` files scattered across `/opt/*/`, `/etc/litellm/litellm.env`, `/root/.profile`, and SSH key files. No inventory, no rotation workflow, no access audit.

Required additions:

**Secrets Inventory** (read-only discovery, no secret values displayed):

- Scan known `.env` files and environment variable files (configurable list, never auto-scan arbitrary paths).
- Inventory each secret by: name, service, type (API key / SSH key / token / password / connection string), detected algorithm/format, last modified timestamp.
- Flag secrets that are: rotated > 90 days ago, used by multiple services, stored in insecure locations (world-readable files).
- Do NOT display secret values. Display only name, service, age, and risk indicators.

**Rotation Workflow**:
- For each secret, provide a rotation guide (not auto-rotation — that is too risky in v1).
- Guide shows: what the secret is used for, how to generate a new one, where to update it, what to restart after updating.
- After operator confirms rotation is complete, mark the secret as "recently rotated" and clear the "old" flag.

**Secret in Prompt/Output Detection**:
- The AI call trace system scans all prompts sent to external models for detected secrets.
- Uses regex patterns: AWS key format, OpenAI key format, Anthropic key format, GitHub PAT format, generic `sk-*` patterns, SSH key headers.
- Detected secrets are redacted in the trace before storage.
- A critical alert fires if a secret is detected in an external model prompt.

**SSH Key Inventory**:
- Scan `~/.ssh/` for key files.
- Report key type, age, permissions (must be 600), comment (often contains email or host).
- Flag keys with world-readable permissions.

### 41.4 AI Safety Controls

**Tool Call Allowlisting**:

Every shell command a Builder agent can run must pass an allowlist check before execution. The allowlist is configurable per-project in the Builder workflow config:

```json
{
  "toolPolicy": {
    "shell": {
      "mode": "allowlist",
      "allowed": ["bun run *", "npm run *", "git status", "git diff", "git add", "git commit"],
      "blocked": ["rm -rf *", "curl * | sh", "sudo *", "systemctl *"],
      "requireApproval": ["git push *", "systemctl restart *", "./deploy.sh"]
    },
    "network": {
      "allowedHosts": ["127.0.0.1", "localhost", "api.openrouter.ai"],
      "requireApprovalForUnknownHosts": true
    },
    "filesystem": {
      "writableRoots": ["$PROJECT_ROOT"],
      "protectedPaths": ["/etc/", "/var/lib/", "/root/.ssh/", "/opt/newsbites/content/"],
      "requireApprovalForProtected": true
    }
  }
}
```

Blocked commands are refused with an audit entry. Approval-required commands pause the pass and notify the operator.

**Rate Limiting on Agent API Budget**:
- Per-workflow daily token budget (configurable in workflow settings).
- Per-provider daily spend cap from Settings.
- When a budget is exceeded, the Builder pass receives a `budget_exceeded` signal and must set `status: blocked` in PASS_RESULT.json.

**Runaway Agent Kill Switch**:
- If a single pass exceeds 3x the expected token count for its model and task type, emit a warning.
- If a Builder run has 5+ consecutive `agent-stalled` or `agent-oom` failures, pause the workflow automatically and send a critical alert.
- The operator can kill any active pass from the Builder page without needing terminal access.

### 41.5 Audit Log Hardening

Current state: audit entries exist but are not hash-chained (implementation is partial).

Required:

- **Hash chain**: Each audit entry includes `prev_hash` (SHA-256 of the previous entry's canonical JSON). The `chain_head` endpoint returns the current head hash for external verification.
- **Immutable writes**: Audit entries are insert-only. No UPDATE or DELETE is permitted on `action_audit`. The API enforces this at the ORM/query layer.
- **Retention enforcement**: A background job runs nightly to check entries older than the configured retention period and exports them to a durable location before deletion.
- **Export to append-only storage**: Option to replicate audit entries to an append-only log file on disk (rotated by date, gzip-compressed, SHA-256 checksum per file).
- **Tamper alert**: The chain verifier runs on a schedule (daily) and fires a critical alert if any chain break is detected.

### 41.6 Network Security Monitoring

- Log all outbound HTTP/HTTPS connections from agent tool calls (via a network proxy or LD_PRELOAD hook around agent processes — implementation TBD per agent type).
- Flag connections to new/unknown domains in the AI call trace.
- Alert on connections to known-malicious domains (basic blocklist).
- Show outbound network activity per Builder run in the run detail page.

---

## 42. Scalability Architecture Gaps

### 42.1 SQLite Concurrency

Current SQLite setup will hit write-lock contention as:
- Multiple concurrent Builder passes write analytics simultaneously.
- Telemetry sampler writes every few seconds.
- SSE stream reads happen concurrently with writes.

Required:

- Enable WAL (Write-Ahead Logging) mode: `PRAGMA journal_mode=WAL;`. This is the single highest-impact change — allows concurrent reads during writes.
- Set `PRAGMA busy_timeout=5000` to retry writes instead of failing immediately.
- Batch telemetry writes using a write queue (write every 2 seconds in bulk, not per-event).
- Use read-only connections for SSE event polling; use a separate write-only connection pool.
- Add `PRAGMA synchronous=NORMAL` for a balance between safety and write speed.

### 42.2 Data Archival and Retention

Without archival, the SQLite file grows without bound and will eventually cause performance degradation or disk exhaustion.

Required:

- **Events table**: Archive events older than 30 days to JSONL files under `/var/lib/control-surface/archive/events/YYYY-MM.jsonl.gz`. Delete archived rows.
- **Builder run artifacts**: Compress stdout/stderr files in completed runs older than 14 days. Delete runs older than configured retention period.
- **Gateway calls**: Archive call records older than 90 days.
- **Audit log**: Archive entries older than 1 year (configurable). Never delete — export to immutable storage before archival delete.
- **SSE event buffer**: Limit in-memory SSE buffer to last 500 events per stream. Do not keep all historical events in memory.
- **Archival job**: Run nightly as a systemd timer (`control-surface-archive.timer`). Report archival results to Today page.

### 42.3 Builder Pass Resource Budgeting

On a CX32 (8GB RAM, 4 vCPUs), uncontrolled concurrent passes will exhaust RAM:

- **Memory estimation**: Before starting a pass, check available RAM. If < 1.5GB available, queue the pass instead of starting it.
- **CPU throttling**: Use `cpulimit` or cgroup limits to prevent a single pass from consuming > 50% CPU for more than 60 seconds.
- **Disk quota**: Set a per-run directory size limit. If a pass writes > 500MB to its run dir, warn the operator and consider pausing.
- **Concurrency cap**: Max concurrent active passes = `min(4, floor(availableRamGB / 1.5))`. Configurable in settings.
- **OOM detection**: Monitor `/proc/meminfo`. If available RAM drops below 512MB, pause all queued passes and alert.

### 42.4 SSE Connection Bounding

- Max concurrent SSE connections per endpoint: 10 (configurable).
- If limit is reached, return 429 to new SSE requests with `Retry-After` header.
- Automatically close SSE connections that have been idle (no data sent) for > 2 minutes.
- Add a `/api/health/sse-stats` endpoint showing current connection count and streams.

### 42.5 API Pagination Enforcement

All list endpoints that return unbounded arrays must be paginated:

- Add `?limit=&offset=` or `?cursor=&limit=` to all list endpoints.
- Default limit: 50 items. Maximum limit: 500 items.
- Large exports (audit export, report generation) run as background jobs with downloadable artifacts, not as synchronous HTTP responses.
- The UI must handle paginated responses everywhere (no "load all" for large datasets).

### 42.6 Multi-Project Write Conflict Prevention

- Add a `project_locks` table: `(project_root TEXT, workflow_id TEXT, locked_at INTEGER, expires_at INTEGER)`.
- Before starting a Builder run, check if the target project root is locked.
- If locked: show who locked it, when it expires, and offer to queue the new run.
- Lock expires automatically after `max_passes * max_seconds_per_pass` to prevent orphan locks.
- On workflow completion/failure, release the lock immediately.

---

## 43. Missing Functional Areas

The following functional areas are entirely absent from the current control surface and need dedicated pages or major sub-sections:

### 43.1 Content Calendar

A visual editorial schedule view showing:

- Published articles by date and vertical (calendar grid).
- Scheduled/planned articles (from dossiers in `publish-prep` stage).
- Coverage gaps (verticals with no articles in the last N days).
- Publishing cadence chart (articles per day over 30 days).
- "Next to publish" queue ranked by readiness.
- Vertical balance chart (pie or bar of articles by vertical this month).

Primary actions:
- Move a dossier's target publish date.
- Add a topic directly from a coverage gap.
- Mark a vertical as temporarily paused.

Phase placement: Extends Phase 4 Production Desk.

### 43.2 Reader Analytics Integration

Pull site performance data into the dashboard:

- Page views per article (from Cloudflare Analytics or a lightweight counter).
- Top-performing articles this week.
- Articles with zero traffic after N days (content that didn't land).
- Click-through rates from article list to full read.
- Reader app engagement (time in Focus mode vs Flow mode).
- Panel engagement (which panels are clicked most).

The goal is editorial feedback loops: write more of what works, less of what doesn't.

Phase placement: New Phase after Production Desk (Phase 4.5).

### 43.3 Unified Log Explorer

A browser-based log viewer across all services:

- Source selector: choose one or multiple services (systemd, Docker, journald sources).
- Time range picker.
- Free-text search (grep equivalent).
- Log level filter: `error`, `warn`, `info`, `debug`.
- Auto-highlight error patterns, stack traces, known MIMULE error signatures.
- "Copy filtered log" action (for incident reports, AI Vault entries).
- "Send to Telegram" action for log excerpts.
- Link selected log lines to a new incident.

Backend: streams from `journalctl` and `docker logs` via a buffered SSE endpoint. Logs are not persistently stored in SQLite — stream-only.

Phase placement: Extends Phase 6 (Infra) and Phase 8 (Incidents). New Phase 5.5.

### 43.4 Dependency Manager

View and manage npm/pip/go/cargo dependencies across all services:

- List all dependencies for each detected project with current version.
- Flag outdated packages (compare against npm/pub/pkg.go.dev registry).
- Flag packages with known CVEs (integrate with `npm audit` or OSV).
- "Update all safe minor versions" action (generates a Builder task, not a direct action).
- Show which services share a dependency (useful for coordinating upgrades).
- Lockfile age indicator.

Phase placement: New Phase 10.5 (after packaging, before GA).

### 43.5 Environment Variable Manager

View and safely manage environment variables across services:

- Read `.env` files for each service (configurable trusted paths only).
- Display variable names and masked values (show last 4 chars).
- Flag missing required variables (each service can declare its required vars).
- Flag variables that are defined but not used (static analysis of service source).
- "Edit variable" action: opens a secure edit form, saves to the `.env` file, and queues a service restart if needed.
- Audit trail of every env var change.
- Never expose values in logs or browser history.

Phase placement: Extends Phase 8.5 Governance (secrets management).

### 43.6 Backup Manager

Dedicated backup management page:

- List all backups in `/opt/backups/` with date, size, contents summary.
- Run backup now action.
- Verify backup action (check archive integrity, not just existence).
- Download backup (for off-site storage) — compressed streaming download.
- Delete old backup (with retention policy enforcement).
- Restore guidance (step-by-step runbook for each backup type, not automated restore in v1).
- Backup age alert: if no backup exists in the last 24 hours, fire a critical alert.

Phase placement: Extends Phase 5 Infra.

### 43.7 Network Map (Visual)

A simple visual diagram of how services connect:

- Node for each service: NewsBites, TIB Markets, Paperclip, OpenClaw/Mimule, LiteLLM, Autopipeline, Control Surface.
- Edge for each connection: which services call which, on which ports.
- Node for external providers: Cloudflare Tunnel, Vast.ai GPU, OpenRouter, GitHub Models.
- Color-coded by health: green / amber / red.
- Click a node to jump to the relevant page.
- Shows the Caddy routing layer and which domains map to which services.

This is a read-only visualization. No interactive editing.

Phase placement: New Phase 5.1 (visual companion to Infra page).

### 43.8 MCP Server and Plugin Registry

A registry of all installed MCP servers and Claude Code skills/hooks:

- List MCP servers from Claude Code configuration.
- Show which pages/agents use each MCP server.
- Show last active status (was the server successfully called in the last session?).
- Add / remove MCP server (edits the configuration file, then restarts the relevant agent session).
- List Claude Code skills (`/skillname`) and their descriptions.
- List active hooks (pre-tool, post-tool, etc.) and their status.
- Test an MCP server connection.

Phase placement: Extends Phase 6 Agent Cockpit Parity.

### 43.9 Scheduled Reports Manager

A dedicated page for managing recurring report generation:

- List all scheduled report jobs with schedule, last run time, last run status.
- Create a new scheduled report (select template, parameters, schedule using a cron picker — no raw cron syntax, use a human-readable scheduler: "every morning at 7:30 UTC", "every Monday at 08:00").
- Pause / resume / delete a scheduled report.
- Run now (manual trigger).
- View last N report runs with download links.
- Configure per-schedule delivery preferences (Telegram / AI Vault / download only).

Phase placement: Extends Phase 2 Real Reports.

### 43.10 Experiment Tracker

Track A/B tests across prompts, models, and routing policies:

- Create an experiment: name, hypothesis, control config, variant config, metric to optimize (quality score / latency / cost / error rate).
- Run N samples through control and variant.
- Compare results side by side.
- AI-generated conclusion ("variant B is 23% faster and 8% cheaper with equivalent quality score").
- Promote variant to production (updates LiteLLM config or routing policy).
- Archive experiment with conclusion.

Phase placement: Month 5 of AGENT_FRIENDLY_6_MONTH_PLAN.md (Operator Copilot). New Phase 5.8.

### 43.11 Stack Knowledge Base

An AI-generated, searchable knowledge base about the MIMULE/TechInsiderBytes stack:

- Auto-generated documentation for each detected service (purpose, architecture, dependencies, deployment, known issues).
- Auto-generated runbooks for common operations (how to add an article, how to fix a stuck queue item, how to restart the GPU tunnel).
- Searchable via the global search / command palette.
- Updated automatically when the stack changes (new service detected, plan file completed, incident resolved with new runbook).
- Every runbook has an "Execute" action that links to the relevant dashboard page and pre-fills the relevant action form.
- Linked from every error message and incident via "View Runbook" action.

Phase placement: New Phase 5.9 (intelligence layer, before final polish).

---

## 44. Anomaly Detection and Auto-Fix Catalog

### 44.1 Anomaly Detection Methods

The following anomalies must be detected automatically, without operator configuration:

#### Service Anomalies
- Service exit (any systemd service that transitions to `failed` state).
- Service repeated restart (more than 3 restarts in 1 hour).
- Service memory growth (RSS growing > 20% per hour for 3 consecutive hours).
- HTTP probe failure (internal or external).
- Response time degradation (probe latency > 3x 7-day baseline for 5 consecutive probes).
- Docker container OOM kill (exit code 137).
- Caddy upstream timeout increase (detected from Caddy log patterns).

#### Pipeline Anomalies
- Queue item age > configurable threshold with no stage progress.
- Stage failure rate spike (> 30% failure rate in 30 minutes, vs baseline < 5%).
- Approval queue depth > N items for > M hours.
- No new articles published in > 18 hours during active operating hours.
- Dossier age > 24 hours in `write` or `verify` stage (likely stuck).

#### Model and AI Anomalies
- Model error rate > 20% over 15-minute window.
- Model latency > 2x baseline for 10 consecutive calls.
- Rate limit hit 3 times in 1 hour (approaching quota).
- All models in fallback chain simultaneously degraded.
- Cloud spend spike: hourly cost > 2x daily average hourly rate.
- Token usage per response growing (model producing verbose outputs — quality risk).

#### Infrastructure Anomalies
- Disk usage > threshold on any mount.
- RAM available < 512MB for > 5 minutes.
- Load average > 3.5 (all 4 vCPU saturated) for > 2 minutes.
- Vast tunnel down > 5 minutes.
- GPU tunnel latency > 5s for simple ping.
- Backup absent > 24 hours.
- SSH key expiry within 30 days (if expiry is tracked).
- Certificate expiry within 14 days.

#### Agent and Builder Anomalies
- Builder pass failure rate > 50% over last 10 passes (systemic issue, not random).
- Pass consistently timing out at the same plan step (plan is too large for model context).
- Agent writing to files outside its allowed project root.
- Agent making network calls to unexpected external hosts.
- AI Vault not logged for > 24 hours of agent activity.

#### Security Anomalies
- Failed auth attempts > 5 in 10 minutes.
- Request from previously unseen IP (if IP binding is configured).
- Secret pattern detected in AI prompt or output.
- Audit chain break.
- Unexpected process listening on a new port.

### 44.2 Auto-Fix Catalog

The following conditions have safe auto-fixes that can run without operator approval (Tier 0 — suggest) or with low-risk approval (Tier 1 — auto with notification):

| Condition | Auto-Fix | Tier | Rationale |
|---|---|---|---|
| Builder run dirs > 90 days old | Archive stdout/stderr, compress, delete original | Tier 1 | Purely disk hygiene, no state impact |
| Pipeline item stuck for > 6 hours | Mark as stale, notify operator | Tier 0 | Surface the problem; don't kill without operator decision |
| Model rate-limited | Pause routing to that model for cooldown period | Tier 1 | Safe; LiteLLM already does this, but dashboard should reflect it |
| Vast tunnel down | Restart `vast-tunnel.service` after 5 minutes | Tier 1 | Known-safe restart; the service is designed to reconnect |
| Disk > 85% | Compress old builder run artifacts | Tier 1 | Safe cleanup; compressed artifacts remain available |
| Old alert suppressions expired | Remove expired suppression entries from table | Tier 1 | Maintenance; no operator impact |
| Model health file > 6h stale | Trigger model-health-check.service | Tier 1 | Safe read-only health check |
| Backup absent > 24h | Trigger mimule-backup.service | Tier 1 | Safe backup; does not delete anything |
| newsbites.service exits unexpectedly | Notify operator + provide 1-click restart with impact preview | Tier 0 | Restart is safe but operator should confirm |
| Builder workflow has no activity for > N hours | Notify operator to check if workflow is stuck | Tier 0 | No auto-action — must be operator decision |
| All external models degraded | Switch Autopipeline to GPU-only mode if GPU is up | Tier 1 | Reduces cost; GPU quality is equivalent |
| Certificate expiry < 14 days | Alert and link to Caddy renewal guide | Tier 0 | Manual action required |

Tier 2 auto-fixes (require explicit operator approval before execution):

| Condition | Proposed Fix | Why Approval Required |
|---|---|---|
| Live service failure for > 10 minutes | Restart the service | Live user impact; must confirm |
| Build fails after deploy | Roll back to last known good deployment | Destructive; affects production |
| Pipeline queue item in error for > 3 retries | Kill item and create follow-up task | Data may be partially processed |
| LiteLLM service crash | Restart litellm.service | Affects all model routing |

---

## 45. Embedded Agentic AI — Page-Level Requirements

Every major page must implement the AI Assistance Contract defined in Section 6.1. The following table specifies the minimum AI integration required per page, beyond what is already defined:

### 45.1 Today Page

- Auto-generate the daily priority deck using AI reasoning over current data (not just threshold checks).
- AI selects and ranks the top 5 priorities using multi-factor reasoning: user impact, recency, trend, reversibility.
- Each priority card includes an AI-written 1-2 sentence explanation ("why this matters now") and a recommended first action.
- AI detects "nothing urgent today" state and generates a positive summary ("NewsBites published 3 articles overnight, all models healthy, pipeline running normally").
- "Ask AI" button on Today opens the conversational query interface.

### 45.2 Production Page

- AI scans all dossiers and articles and surfaces editorially significant patterns: "Finance vertical has had no articles in 4 days", "3 dossiers in verify stage are blocking publication", "Today's articles have lower source coverage than this week's average".
- AI suggests topics based on coverage gaps and trending signals.
- AI validates frontmatter for every article in a background pass and surfaces issues (missing lead, wrong vertical, duplicate slug) without operator request.
- "Explain this dossier state" action on every dossier row.

### 45.3 Pipeline Page

- AI explains why each stuck queue item is stuck (correlates stage age, last model error, GPU state, cloud error rate).
- AI suggests the correct action for each stuck item (retry with different model / inject at different stage / kill and re-queue).
- AI generates a queue health summary ("4 of 11 items are blocked; 2 are waiting for GPU which is currently unavailable; 2 failed at verify stage due to rate limits on nemotron").
- Batch AI: "Analyze all stuck items and suggest a recovery plan."

### 45.4 Models Page

- AI generates a routing recommendation card: "Based on current health and latency data, use `editorial-cloud-heavy` (nemotron) for research tasks and `editorial-fast` (gemma4-31b-free) for write tasks. `editorial-heavy` (local Gemma) is unavailable."
- AI explains each rate-limit event in plain language.
- AI suggests whether to unblock or keep a model in probation based on error pattern.
- AI predicts when the GPU tunnel will next be stressed based on historical patterns.

### 45.5 Builder Page

- AI generates a run health summary per workflow: "This workflow has a 70% pass success rate. The most common failure is `pass-timeout` at Phase 3a. Consider splitting Phase 3 into two smaller plan items."
- AI suggests continuation instructions when a workflow is blocked.
- AI generates a session summary at run completion: "The agent completed 8 of 9 plan items, modified 4 files, all typecheck passed, 1 test was skipped. One item remains: mobile layout fix for TickerIntel. Recommend starting a new pass targeting that item."
- Brainstormer integration: "Plan this workflow with AI assistance" opens the Brainstormer.

### 45.6 Incidents Page

- AI auto-clusters related alerts and events into incidents (not one incident per alert).
- AI writes the incident title and summary from the triggering events.
- AI generates a root cause hypothesis with evidence for every incident.
- AI generates a remediation plan from the knowledge base runbooks.
- AI summarizes incident resolution for AI Vault logging ("GPU tunnel was down from 02:14 to 03:41 UTC. Cause: Vast.ai instance hibernation. Resolved by: SSH reconnect. Impact: 3 pipeline items fell back to cloud models. Cost: ~$0.30 in emergency cloud usage.").

### 45.7 Doctor Page

- AI clusters all symptoms into named conditions ("GPU connectivity issue", "LiteLLM model degradation", "NewsBites deploy failure").
- AI confidence score per diagnosis.
- AI proposed remediation steps per diagnosis, ordered by confidence.
- AI "go hunt" actions: "Find all events related to this symptom in the last 24 hours."
- AI post-incident timeline generator.

### 45.8 Infra Page

- AI explains every service state (not just green/red — why, how long, what it means for the stack).
- AI generates a disk projection: "At current growth rate (45MB/day from builder run artifacts), disk will reach 85% in approximately 18 days. Recommended action: archive builder runs older than 30 days."
- AI summarizes overnight infrastructure events.

### 45.9 Audit Page

- AI provides semantic search over audit log ("show me all actions related to the GPU tunnel this week").
- AI generates an audit narrative for a time period ("what happened on May 14th?").
- AI detects unusual audit patterns ("operator has not logged in for 3 days but 47 actions were recorded — all from automation tokens").

### 45.10 Reports

- All reports include AI-generated executive summary, key findings, and recommended next actions.
- AI interprets trends ("article publish rate is down 40% this week — investigate whether this is intentional or a pipeline issue").
- AI suggests report schedule based on how frequently the data changes.

---

## 46. Phase Placement Map — Updated

This extends and amends Section 34.

| New Area | Phase Placement |
|---|---|
| Brainstormer / Strategic Planning Studio | New Phase 7.5 — after Builder as Repeatable Work System |
| Settings Full Control Inventory | Extends Phase 0 (basic) and Phase 5 (full controls) |
| Zero-Typing GUI Policy | Cross-cutting — enforce starting Phase 0 for new forms, retrofit existing forms in Phase 3 |
| AI Auto-Detection Engine | New Phase 1.7 — after Today and before broad entity expansion |
| AI Conversational Query Interface | New Phase 3.7 — after actionability and search foundation |
| Security Control Plane (auth hardening) | Extends Phase 8.5 Governance — begin auth audit in Phase 0 |
| Secrets and Credential Management UI | Extends Phase 8.5 Governance |
| Tool Call Allowlisting | New Phase 7.2 — part of Builder Repeatable Work System |
| SQLite WAL + concurrency fixes | Phase 0 — immediate, highest risk if deferred |
| Data Archival and Retention jobs | New Phase 1.8 — after Today, low cost, high safety value |
| Builder Pass Resource Budgeting | Extends Phase 7 Builder |
| SSE Connection Bounding | Phase 0 — stability fix |
| Content Calendar | Extends Phase 4 Production Desk (Phase 4.1) |
| Reader Analytics Integration | New Phase 4.5 |
| Unified Log Explorer | New Phase 5.5 |
| Backup Manager | Extends Phase 5 Infra (Phase 5.1) |
| Network Map | New Phase 5.2 |
| MCP Server and Plugin Registry | Extends Phase 6 Agent Cockpit (Phase 6.5) |
| Scheduled Reports Manager | Extends Phase 2 Real Reports (Phase 2.5) |
| Experiment Tracker | New Phase 5.8 |
| Stack Knowledge Base | New Phase 5.9 |
| Anomaly Detection Engine | New Phase 1.5 (co-builds with Alerting Center) |
| Auto-Fix Catalog (Tier 0+1) | New Phase 3.8 — after actionability engine |
| Dependency Manager | New Phase 10.5 |
| Environment Variable Manager | Extends Phase 8.5 Governance |
| Embedded AI per page | Cross-cutting — integrate per page as pages are built |

## 47. Critical Cross-Cutting Gaps Not Yet Addressed

The following gaps span multiple sections and require explicit architectural decisions before implementation:

### 47.1 Offline and Resilient Operation

The dashboard must function when the VPS itself is partially degraded:

- If `/api/*` returns 503, pages must show a "Dashboard API unavailable" banner with the last-known state from browser localStorage.
- Certain read-only views (last known pipeline state, last known model health) should render from cached data when live data is unavailable.
- The SSE connection must gracefully reconnect with exponential backoff (max 30s) and not leave the UI in a stale "connected" state.
- If LiteLLM is down, the AI features (Explain This, conversational queries, AI digests) must degrade gracefully with a "AI assistance unavailable — LiteLLM is not responding" message, not a silent failure.

### 47.2 Mobile Push vs. Pull Architecture

The current mobile experience is pull-only (operator must open the app to see status). The Telegram bridge provides push, but only for pre-configured alerts. A better model:

- Dashboard sends Telegram notifications proactively for critical and page-severity events.
- The Telegram message includes a deep link to the relevant dashboard page and specific entity.
- Deep links on mobile open the dashboard directly to the relevant page and entity (parameterized routes: `/incidents/inc_abc123`, `/jobs/job_xyz456`).
- The operator can take basic actions from Telegram inline keyboards (acknowledge alert, approve pipeline item, generate morning brief) without opening the full dashboard.
- These Telegram action callbacks are handled by the existing OpenClaw/Mimule bot and forwarded to the dashboard API.

### 47.3 Form State Persistence

All multi-step forms (workflow creation, brainstormer session, report configuration) must persist their state:

- If the operator navigates away mid-form, state is saved to `localStorage` or the backend.
- On return, the form resumes from where it was left.
- Saved form state expires after 24 hours.
- Indicator shows "Draft from [time]" when a saved state is restored.

### 47.4 Real-Time Collaboration Awareness

Even with a single operator, the dashboard must handle multiple browser tabs or devices:

- SSE updates must propagate to all open connections immediately.
- If action X is taken in tab A, tab B must reflect the result within 2 seconds (via SSE).
- If an automation token takes an action, the operator's browser must see the result immediately.
- No stale state after background action completion.

### 47.5 Plan File Format Standardization

As Brainstormer generates plan files and Builder detects them, a standard plan file format is needed:

```markdown
---
plan_id: <uuid>
created_at: <iso timestamp>
created_by: <operator|brainstormer|manual>
target_project: <filesystem path>
mode: <build|fix|refactor|investigate|secure|document|test>
urgency: <exploration|planned|urgent|critical>
recommended_agent: <claude|codex|opencode|gemini>
recommended_model: <logical model name>
estimated_passes: <N>
status: <new|in_progress|blocked|complete>
builder_run_id: <if associated with a Builder run>
brainstorm_session_id: <if generated by Brainstormer>
---

# Plan: [Title]
...
```

The YAML frontmatter is machine-readable. The Builder scanner uses it to classify plans. The Brainstormer writes it. The dashboard plan registry stores a parsed version in the database.

### 47.6 The "Nothing Typed, Nothing Misunderstood" Standard

As a quality gate for every new form, dialog, and settings control, apply the following checklist:

- [x] No text field where a dropdown, picker, or autocomplete is possible.
- [x] No raw cron expression where a human-readable scheduler is possible.
- [x] No raw filesystem path where a file browser is possible.
- [x] No raw service name where a service picker is possible.
- [x] No raw model ID where a logical model name picker is possible.
- [x] No unexplained input (every field has a tooltip or inline description).
- [x] No required input without a sensible default.
- [x] No form that requires knowledge of the underlying system to fill out correctly.
- [x] No form that can be submitted with values that would obviously fail (validate before submit).
- [x] No submit button labeled "Submit" — use the action name ("Start Workflow", "Add to Pipeline", "Generate Report").

This checklist must be reviewed in the code review for every new UI form that lands.

---

## 48. Updated Priority List

Additions and amendments to the existing priority list (Sections 13 and 33):

### New P0 (Immediate, Blocking)

- Enable SQLite WAL mode and busy_timeout (stability risk under concurrent load).
- Fix SSE connection bounding (unbounded connections will exhaust file descriptors).
- Add `project_locks` table to prevent concurrent runs on the same project.

### New P1 (High Value, Low Risk)

- Build Settings page with full control inventory (Section 38).
- Implement Zero-Typing policy for Builder workflow form (plan picker, project picker, model dropdown, agent picker).
- Implement Brainstormer page (research + planning phases first, commit phase second).
- Add Builder plan auto-detection (scan for new `*PLAN*.md` files with unchecked items).
- Implement anomaly detection for pipeline stuck items, model error rate spikes, and disk pressure.
- Add Tier 1 auto-fixes: vast-tunnel restart, model health check trigger, builder artifact compression.
- Add "Explain This" action to all error displays, model statuses, and queue items.
- Add AI digest scheduler (stack health every 15m, error cluster every 30m).

### New P2 (Important, Planned)

- Implement conversational query interface (Cmd+K).
- Build Content Calendar page.
- Build Unified Log Explorer.
- Build Backup Manager page.
- Build Network Map visualization.
- Implement Scheduled Reports Manager.
- Implement form state persistence for multi-step forms.
- Add deep-link support for all entities (incidents, jobs, runs, articles, dossiers).
- Add Telegram deep-link integration (critical alerts link directly to entity).

### New P3 (Future)

- Reader Analytics Integration.
- Experiment Tracker.
- Stack Knowledge Base.
- MCP Server and Plugin Registry.
- Dependency Manager.
- Environment Variable Manager.
- Brainstormer → Builder auto-detection and direct integration.

---

## 49. Summary of What This Plan Now Covers

This section summarizes the full scope of what the control surface must eventually be, for quick orientation:

### Operator Cockpit Layer
Today, Reports, Alerts/Notifications, Conversational Query, Morning Brief, AI Digest

### Production Operations Layer
Production Desk (NewsBites + content), Content Calendar, Reader Analytics, Pipeline, Pipeline Batch Operations

### Intelligence and AI Layer
Autopipeline AI explanations, Model routing recommendations, Doctor 2.0 with AI diagnosis, Brainstormer (plan creation), AI Digests, "Explain This" everywhere, Conversational query, Experiment Tracker

### Model and Cost Control Layer
Models page with routing simulation, Cost Ledger, Budget alerts, Rate-limit detection, Model health auto-detection, Provider status monitoring, Experiment-driven model selection

### Builder and Agent Layer
Builder (repeatable work), Brainstormer (plan creation), Agent cockpit parity (Claude/Codex/OpenCode/Gemini), Tool call allowlisting, Resource budgeting, Pass analytics, AI Vault integration

### Infrastructure and Security Layer
Infra (services/containers/timers/disk), Backup Manager, Network Map, Log Explorer, Secrets Inventory, Credential rotation guides, Auth hardening, RBAC, IP allowlisting, Audit hardening, Secret-in-prompt detection

### Settings and Configuration Layer
Full operator settings (Section 38), Zero-typing policy (Section 39), AI auto-detection engine (Section 40), Environment Variable Manager, MCP/Plugin Registry

### Governance and Compliance Layer
Policy engine, AI run tracing, Governance home, Identity/access, Data protection, AI safety, Risk engine, Evidence collection, Compliance report center, Incident/investigation center

### Scalability and Reliability Layer
SQLite WAL + concurrency, Data archival/retention, Builder resource budgeting, SSE bounding, API pagination, Project locks, Anomaly detection engine, Auto-fix catalog (Tiers 0, 1, 2)

---

## 50. Cross-Plan Gap Closure Addendum

Added after reviewing:

- `/opt/opencode-control-surface/CONTROL_SURFACE_USABLE_PRODUCT_PLAN.md`
- `/opt/opencode-control-surface/DASHBOARD_V4_STYLE_FIX_PLAN.md`
- `/root/BUILDER_EXCELLENCE_PLAN.md`
- `/root/BUILDER_PLATFORM_12_MONTH_PLAN.md`
- `/root/DASHBOARD_V4_PLAN.md`

The existing plans are ambitious but still leave some requirements implicit or scattered. This addendum converts the remaining gaps into explicit product contracts. Any implementation slice should check itself against this section before it is considered done.

### 50.1 Biggest Current Product Gaps

The control surface is not yet scalable because:

- it lacks an explicit ingestion/backpressure model for logs, events, AI traces, probes, reports, and workload graph updates;
- it lacks hard pagination/cursor standards for every growing API;
- it lacks retention classes and archival jobs before adding high-volume traces, logs, screenshots, reports, and Builder artifacts;
- it lacks resource budgets for Builder passes, AI digests, report generation, probe jobs, and model evaluations;
- it lacks concurrency controls across project roots, services, tmux sessions, report jobs, and action execution;
- it lacks graceful degraded-mode behavior when SQLite is locked, SSE drops, LiteLLM is down, Autopipeline is unreachable, Docker is slow, or a source times out;
- it lacks a clear split between fast live summaries, cached derived views, and slow background analysis.

It is not yet fit for all use cases because:

- private MIMULE operations, future standalone installs, closed-beta tenants, auditors, and mobile-only triage have different needs but the UI does not yet expose mode-based views;
- editorial, infrastructure, AI, security, compliance, cost, and Builder work all need first-class entity detail pages and not only route-level tables;
- successful work is still less visible than failures, which makes daily production review incomplete;
- planning, execution, investigation, reporting, and audit are not yet one connected loop;
- the product does not yet provide enough guided flows for non-expert operators who do not know paths, service names, model names, cron syntax, or validation commands.

It is not easy enough to use because:

- too many pages require the operator to infer meaning from raw tables and status pills;
- the UI still asks for raw values in places where it should provide pickers, file browsers, discovered defaults, or AI-prefilled forms;
- route names, product vocabulary, lab surfaces, and platformization concepts compete with the daily cockpit;
- mobile is still a compressed desktop dashboard rather than a purpose-built decision surface;
- errors often say what failed but not why, what it affects, what to do, and what is safe to automate.

It is not documented enough because:

- there is no in-product explanation layer for entities, actions, policies, reports, and settings;
- there is no operator manual generated from live settings and detected stack topology;
- runbooks are not consistently linked to actions, incidents, services, or credentials;
- API contracts, report schemas, policy semantics, and plan-file formats need stable reference docs before broader productization.

### 50.2 Product Modes Required

Add a mode selector or inferred view mode so the same product can serve different jobs without overwhelming the operator:

| Mode | User Need | UI Shape |
|---|---|---|
| Quick Check | "What matters now?" | Today, priorities, one-tap actions, AI summary, mobile-first. |
| Production Desk | "What should publish or be fixed?" | Articles, dossiers, pipeline, content quality, calendar, approvals. |
| Investigation | "Why did this happen?" | Timelines, logs, traces, deploys, policies, evidence, related entities. |
| Build | "Turn this idea or plan into validated work." | Brainstormer, Builder, agents, plan registry, validation, handoff. |
| Governance | "Was this safe, allowed, and auditable?" | Policies, controls, AI traces, labels, sensitive detections, audit chain. |
| Admin | "Configure the stack." | Settings, credentials metadata, services, paths, model policy, notifications. |
| Packaging | "Install or operate as a product." | Hidden until core is usable; standalone docs, license, onboarding, updates. |

Acceptance:

- No page should mix all modes at once.
- Mobile defaults to Quick Check and Guided Fix.
- Desktop can expose Investigation, Build, Governance, and Admin depth.
- Lab/platform pages stay out of primary navigation until they pass the relevant mode acceptance criteria.

### 50.3 Entity Detail Pages Are Missing

The product cannot scale as route-level tables only. Add stable entity detail routes or drawers for:

- service,
- container,
- timer,
- public URL,
- model,
- provider,
- fallback chain,
- article,
- dossier,
- pipeline item,
- Paperclip agent,
- agent session,
- Builder workflow,
- Builder run,
- Builder pass,
- job,
- incident,
- alert,
- report run,
- policy,
- control,
- evidence item,
- credential metadata item,
- deployment,
- maintenance window,
- project,
- plan file,
- AI run,
- tool call.

Every entity detail must include:

- current state,
- timeline,
- evidence,
- related entities,
- policies that apply,
- safe actions,
- AI explanation,
- recent changes,
- reports that include it,
- audit history,
- "open in command palette" deep link.

### 50.4 Zero-Typing Must Become A Build Gate

The "Nothing Typed, Nothing Misunderstood" standard in Section 47.6 must become mandatory, not aspirational.

Disallow raw text inputs for:

- filesystem paths,
- service names,
- Docker container names,
- systemd timer names,
- model IDs,
- provider names,
- vertical names,
- project roots,
- plan files,
- validation commands,
- cron schedules,
- report templates,
- policy scopes,
- affected entities,
- Telegram routing categories.

Use instead:

- discovered entity pickers,
- fuzzy search,
- tree/file browser rooted at allowlisted directories,
- autocomplete from known stack data,
- chips for multi-select values,
- guided schedule builder,
- action-specific form presets,
- AI-prefilled draft values with "inferred" labels.

Allowed exceptions:

- freeform goal/topic prompts;
- operator notes;
- incident resolution notes;
- report custom titles;
- advanced/labs JSON editors hidden behind an explicit "advanced" disclosure.

Acceptance:

- Every new form must list which fields are discovered, inferred, manually entered, and validated.
- Invalid values must be blocked before submission.
- AI-inferred values must be editable and must show their evidence source.
- Forms must save drafts and restore within 24 hours.

### 50.5 Embedded Agentic AI System Requirements

The plan already says AI should explain and recommend. The missing architecture is a shared AI assistance substrate.

Add a `server/assistant/` or `server/reasoner/` layer with:

- page-level digest jobs,
- entity-level explain jobs,
- incident diagnosis jobs,
- report summary jobs,
- plan-generation jobs,
- policy-simulation explanation jobs,
- model-routing recommendation jobs,
- safe auto-fix recommendation jobs.

Minimum AI job contract:

```ts
interface AiAssistanceJob {
  id: string;
  kind:
    | "page-digest"
    | "entity-explain"
    | "incident-diagnosis"
    | "report-summary"
    | "plan-generation"
    | "policy-explanation"
    | "routing-recommendation"
    | "auto-fix-recommendation";
  entityType?: string;
  entityId?: string;
  inputEvidenceRefs: EvidenceRef[];
  status: "queued" | "running" | "success" | "partial" | "failed";
  modelLogicalName: string;
  outputJson: string | null;
  confidence: "low" | "medium" | "high";
  createdAt: number;
  finishedAt?: number;
}
```

AI outputs must always include:

- plain-language summary,
- evidence used,
- confidence,
- limitations,
- recommended next actions,
- whether each action is safe, approval-required, or manual-only.

AI outputs must never:

- invent hidden chain-of-thought;
- hide missing evidence;
- execute high-risk actions without approval;
- send sensitive content to external providers unless policy allows it.

### 50.6 Detection Coverage Gaps

Add detectors for these domains. Each detector must emit normalized events, evidence refs, affected entities, and suggested actions.

| Domain | Detectors |
|---|---|
| Service health | restart loops, non-zero exits, memory growth, degraded latency, stale logs, missing health endpoint. |
| Public URLs | non-200, TLS expiry, latency p95 regression, body-hash anomaly, Cloudflare/Caddy mismatch. |
| Pipeline | stuck stages, repeated stage failure, approvals aging, no publish cadence, stale dossiers, missing artifacts. |
| Editorial quality | weak digest, missing lead, duplicate slug, missing panel hints, thin article, low source coverage, stale vertical. |
| Models | rate limits, quota/cap errors, latency drift, quality regression, fallback exhaustion, context overflow, cost spike. |
| Providers | external outage, auth failure, status-page incident, API latency, unknown response schema. |
| Builder | pass timeout, stalled exploration, missing `PASS_RESULT`, incomplete plan, project lock contention, writes outside root. |
| Agents | unlogged sessions, stopped sessions, tool-call errors, unexpected network calls, permission prompts aging. |
| Security | failed auth, secret-like strings in prompts/logs/outputs, audit-chain break, unknown port, risky mobile action. |
| Capacity | disk growth, DB growth, run artifact growth, log ingestion growth, RAM pressure, CPU saturation, Vast runway. |
| Backups | missing backup, unverified backup, oversized backup, restore drill overdue. |
| Docs/plans | stale plan, conflicting plans, broken file references, unmeasurable acceptance criteria. |

Detection methods must include:

- threshold checks,
- absence checks,
- consecutive failure checks,
- rolling baseline comparison,
- peer/entity comparison,
- deploy-aware suppression,
- maintenance-window suppression,
- AI-assisted clustering,
- manual operator override.

### 50.7 Auto-Fix Policy Must Be Explicit

The auto-fix catalog needs approval tiers that are enforced by policy, not just described in docs.

| Tier | Behavior | Examples |
|---|---|---|
| Tier 0 Suggest | AI recommends only; no mutation. | Kill stale pipeline item, restart live service, rollback deploy. |
| Tier 1 Safe Auto | Can run automatically if enabled, audited, and reversible. | run model-health-check, restart vast-tunnel, compress old artifacts, remove expired suppressions. |
| Tier 2 Approval | Requires operator confirmation and reason. | restart production service, switch routing policy, trigger backup, pause Autopipeline. |
| Tier 3 Strong Approval | Requires fresh auth/MFA or two-step confirmation. | edit systemd env, rotate credentials, deploy production, rollback, delete data. |
| Tier 4 Manual Only | Dashboard gives runbook; no execution button. | destructive DB repair, credential value changes, broad filesystem deletes, Cloudflare DNS edits until proven safe. |

Every auto-fix must define:

- preconditions,
- policy requirements,
- dry-run preview,
- exact command/action template,
- expected duration,
- success signal,
- failure signal,
- rollback or fallback,
- audit payload,
- notification behavior.

### 50.8 Controls And Policies Still Missing

Required control families:

- identity/session controls,
- role and permission controls,
- live-service action controls,
- data protection controls,
- secret exposure controls,
- AI model routing controls,
- external provider controls,
- tool-call and shell controls,
- budget controls,
- retention controls,
- evidence controls,
- report generation controls,
- maintenance controls,
- mobile action controls,
- Builder project lock controls,
- agent workspace controls.

Minimum policy templates:

- Require fresh session for live restart.
- Require approval for any action touching `/etc`, `/var/lib`, systemd, Docker, Caddy, Cloudflare, or production article files.
- Block external AI provider calls when prompt/output contains `Credential` or `Secret` label.
- Require source coverage before publish.
- Require AI Vault log after completed Builder or agent work.
- Require `PASS_RESULT.json` for Builder pass success.
- Deny Builder writes outside selected project root.
- Deny concurrent Builder runs on same project unless explicitly allowed.
- Deny model route if provider is blocked, degraded, over budget, or in cooldown.
- Require backup verification before high-risk migrations.
- Require maintenance window for planned downtime actions.
- Require report artifact hash before compliance report is marked complete.

### 50.9 Documentation And Explanation System

Add documentation as a product surface, not only Markdown files in the repo.

Required docs:

- Operator manual generated from detected stack topology.
- Route guide for every core page.
- Entity glossary with examples from this stack.
- Action catalog with risk tiers and rollback notes.
- Policy catalog with report-only/enforced examples.
- Report template reference with source coverage requirements.
- Builder workflow authoring guide.
- Brainstormer plan format reference.
- Troubleshooting runbooks by service/model/pipeline stage.
- Security model: auth, roles, secrets, audit, data labels.
- Install/standalone guide only after Phase 10 is active.

In-product docs requirements:

- every page has a compact "What am I looking at?" help drawer;
- every action has "why this is safe/unsafe";
- every setting has current value, detected source, allowed values, and impact;
- every report explains missing/degraded sources;
- every policy explains report-only vs enforced behavior;
- every AI-generated explanation links to evidence.

### 50.10 Settings Must Become The Control Inventory

Settings is not a dumping ground. It is the editable inventory for the private stack.

Required settings groups:

- Operator profile and session.
- Auth, roles, token/session policy.
- Stack paths and detected project roots.
- Services, containers, timers, public URLs.
- Models, providers, routing policy, quality thresholds.
- Budget, cost, Vast runway, provider spend policy.
- Alerts, Telegram routing, quiet hours, escalation.
- Pipeline/editorial defaults: verticals, publish cadence, source rules, approval defaults.
- Builder defaults: agent, model roster, pass timeout, stall timeout, validation profiles, lock behavior.
- Reports: schedules, retention, export formats, AI Vault logging.
- Governance: labels, policies, exceptions, retention, evidence.
- Credentials metadata and rotation checklists.
- Backups, restore drills, maintenance windows.
- Experimental/labs toggles.
- Danger Zone with strong confirmation.

Each setting must show:

- current value,
- source of truth,
- last changed time,
- last changed by,
- validation state,
- affected features,
- safe default,
- reset action,
- audit history.

### 50.11 Builder And Brainstormer Gaps

Builder is still missing the upstream and downstream parts of the work loop.

Upstream gaps:

- AI-assisted plan creation from a goal.
- Plan conflict detection.
- Plan-file standardization with YAML frontmatter.
- Existing implementation discovery.
- AI Vault and previous Builder run context.
- active-run and dirty-worktree conflict checks.

Execution gaps:

- enforced `PASS_RESULT.json`;
- structured pass analytics;
- project locks;
- write-scope controls;
- resource budgets;
- live pass explanation;
- validation profiles per project;
- plan-progress parsing;
- continuation context from structured artifacts instead of stdout tails.

Downstream gaps:

- session summary;
- changed-file review;
- validation evidence bundle;
- AI Vault log draft;
- follow-up tasks;
- report inclusion;
- incident creation for failed runs;
- reusable workflow promotion;
- "what changed in product value" summary.

Acceptance:

- A user can describe a goal, approve an AI-researched plan, launch Builder, watch progress, review changes, validate, log, and create follow-ups without typing file paths or commands.

### 50.12 Scalability Architecture Requirements

Implement before high-volume features are enabled broadly:

- SQLite WAL mode and `busy_timeout`.
- Read/write transaction budget and slow-query logging.
- Cursor pagination on every collection endpoint.
- API result caps with explicit `nextCursor`.
- Background job queue for reports, AI digests, scans, probes, exports, and model evals.
- Per-job concurrency lanes.
- SSE connection registry with max connections, heartbeat, cleanup, and backoff.
- Event retention classes:
  - hot live state,
  - 72h logs,
  - 30d traces,
  - 90d Builder artifacts,
  - forever audit summaries,
  - explicit compliance evidence packages.
- Artifact storage manifest with hashes and redaction status.
- Archival/compression jobs before deletion.
- Entity graph indexing and FTS reindex jobs.
- Rate limits on expensive actions and AI jobs.
- Degraded-source indicators on every page.

### 50.13 Security Architecture Requirements

Before exposing more mutation controls:

- remove any remaining token-vending or raw-token browser assumptions;
- centralize auth checks in one server middleware;
- centralize role checks and action policy checks;
- replace raw protected `fetch` with `authFetch`;
- enforce CSRF/session semantics for browser mutations;
- rate-limit login/session and mutating endpoints;
- record source IP/user agent where available;
- never persist secret values in dashboard DB;
- redact logs before AI summarization/export;
- add secret detectors to prompts, outputs, logs, report artifacts, and agent transcripts;
- mark external AI calls that contain internal/confidential context;
- add per-action audit reason requirements;
- verify hash chain continuously;
- add backup and restore evidence for DB migrations;
- add security review checklist for every new action handler.

### 50.14 GUI And UX Standards

Every core page should follow this layout order:

1. conclusion,
2. top recommended action,
3. risk/evidence summary,
4. entity list or workflow,
5. details,
6. raw data/export.

Every table must have:

- mobile card alternative or hidden low-value columns;
- row action drawer;
- stable row ID;
- empty state;
- stale/degraded source display;
- export if it is report-like;
- search/filter when more than 20 rows.

Every action button must show:

- label with verb and target,
- risk tier,
- disabled reason if unavailable,
- preview before high-risk execution,
- audit reason where required,
- result link after execution.

Every mobile core flow must be usable with one hand:

- touch targets at least 44px;
- bottom-sheet confirmations;
- no horizontal scrolling outside intentional table wraps;
- no dense 12-column tables as the primary view;
- no hidden primary action behind icon-only ambiguity.

### 50.15 Missing "Build The Product" Areas

The product needs these areas to become complete:

- Onboarding for private stack setup, hidden until stable.
- Setup health checklist: services, URLs, auth, DB, AI, backups.
- Changelog/release notes visible in the app.
- Version and migration center.
- Feature flag/labs registry.
- Import/export of configuration.
- Backup and restore center.
- API token management for automation identities.
- Webhook management.
- Plugin/MCP server registry.
- Adapter registry for models, agents, validators, notifications.
- Sample workflows and templates.
- Product docs route.
- First-run tutorial for standalone packaging later.

These should not all enter primary navigation. They belong in Settings, Admin, Labs, or Packaging mode until mature.

### 50.16 Acceptance Gate For "Usable Product"

The solution is not usable until all of these are true:

- Morning check from phone takes under 2 minutes.
- No core workflow requires typing a filesystem path, service name, model id, cron expression, or validation command.
- Every core entity has evidence, actions, AI explanation, and audit history.
- Successful work and failed work both appear in workload graph and reports.
- A stuck story can be diagnosed and acted on without SSH.
- A model outage can be explained and mitigated without editing config manually.
- A failed service can be restarted with impact preview and rollback hint.
- A Builder run produces structured pass results and understandable handoff.
- Reports generate durable downloadable artifacts.
- Compliance report source gaps are explicit.
- Every action is policy-evaluated and audited.
- Mobile has no primary nav confusion, overlapping controls, or unusable tables.
- Settings can explain and configure the private stack from discovered state.
- AI assistance degrades gracefully when models/providers are unavailable.

### 50.17 Next Implementation Sequence Amendment

Amend the existing recommended sequence with this order:

1. Stability: SQLite WAL, SSE bounding, pagination caps, auth consistency, route readiness.
2. Navigation and mobile: core nav only, More menu, route modes, table/card mobile fixes.
3. Entity foundation: stable IDs, entity detail drawer, evidence refs, deep links.
4. Action foundation: server-generated actions, preview, policy tier, audit, job result links.
5. Detection foundation: alerting, anomaly events, public URL probes, logs, deploy events.
6. AI assistance substrate: explain-this, page digest, entity explain, incident diagnosis.
7. Zero-typing forms: Builder workflow, add-topic, report generation, settings pickers.
8. Reports and evidence bundles.
9. Builder/Brainstormer loop.
10. Governance/security controls.
11. Packaging/productization only after the private operator cockpit is trusted.

This order keeps the product usable while still preserving the long-term Builder + Gateway + Governance platform direction.

---

## 51. Enterprise AI Infrastructure Product Completeness Addendum

This section captures missing product areas that are not explicit enough in the existing plan files. The goal is a sellable enterprise-grade system that can build, audit, govern, detect, explain, track, and safely auto-fix AI infrastructure regardless of source, model, provider, framework, runtime, or deployment topology.

The product should help immediately when a user lands in it. It should not wait for the user to know what to click, what path to enter, what model is failing, or which evidence matters. The first screen must digest the environment, explain posture, rank priorities, and make the next safe action obvious.

### 51.1 Immediate-Value Landing Experience

Add a first-run and every-run experience that answers four questions in the first viewport:

1. What is connected?
2. What is risky or broken?
3. What changed recently?
4. What should I do next?

Required components:

- `Environment Snapshot`: detected projects, agents, models, providers, gateways, data stores, CI/CD systems, observability sources, cloud accounts, and runtimes.
- `AI Infrastructure Posture Score`: security, reliability, cost, quality, governance, and documentation sub-scores.
- `Top Findings`: prioritized risks with business impact, evidence, and fix path.
- `Recent Change Timeline`: deployments, policy changes, model routing changes, failed jobs, new secrets, new providers, and new AI apps.
- `Safe Next Actions`: low-risk automations the user can run immediately.
- `Ask About This Environment`: conversational entry point grounded in the discovered entity graph.
- `Setup Progress`: what is fully connected, partially connected, missing, or degraded.

Acceptance:

- A new user understands whether their AI infrastructure is healthy within 60 seconds.
- The page shows useful findings even if only one connector is configured.
- Missing data is framed as a setup task, not as an empty dashboard.
- Every card can expand into evidence, ownership, and recommended remediation.

### 51.2 Universal Connector And Source Coverage Layer

The current plans mention adapters and integrations, but a sellable product needs an explicit connector model for arbitrary AI infrastructure.

Connector categories:

| Category | Examples | What To Ingest |
|---|---|---|
| LLM gateways | LiteLLM, OpenRouter, Portkey, Helicone, Langfuse, custom OpenAI-compatible proxies | calls, routes, keys metadata, cost, latency, errors, traces. |
| Model providers | OpenAI, Anthropic, Google, Azure OpenAI, AWS Bedrock, Together, Fireworks, Groq, Hugging Face, Ollama, vLLM, llama.cpp | models, usage, quota, pricing, status, quality probes. |
| Agent tools | Claude Code, Codex, OpenCode, Aider, Cursor, Continue, Cline, Devin-like systems, custom CLIs | sessions, prompts, tool calls, files touched, permissions, outcomes. |
| App frameworks | LangChain, LlamaIndex, Semantic Kernel, Mastra, Haystack, custom SDKs | chains, agents, tools, retrievers, prompts, evals, traces. |
| Cloud/runtime | AWS, Azure, GCP, Kubernetes, Docker, systemd, Nomad, Fly, Railway, Vercel, Netlify | workloads, deploys, config, logs, health, network exposure. |
| Data sources | Postgres, MySQL, SQLite, S3, vector DBs, Redis, filesystems, Notion, Drive, GitHub | schemas, sensitive data risk, lineage, access, freshness. |
| CI/CD | GitHub Actions, GitLab CI, Jenkins, Buildkite, deploy scripts | checks, releases, failures, rollback state, provenance. |
| Observability | OpenTelemetry, Prometheus, Grafana, Datadog, Sentry, ELK, CloudWatch | metrics, traces, logs, errors, alerts, SLOs. |
| Governance | IdP, ticketing, SIEM, GRC, code scanning, secret scanning | users, roles, approvals, findings, controls, exceptions. |

Every connector must expose:

- connection health,
- permissions granted,
- scopes requested,
- last sync time,
- ingestion lag,
- entity types produced,
- degraded-source reasons,
- setup checklist,
- safe disconnect path.

### 51.3 AI Asset Inventory And CMDB

Add an AI-native asset inventory. This is more than a project list.

Inventory object types:

- AI application,
- agent,
- workflow,
- model,
- provider,
- gateway,
- prompt template,
- tool/function,
- MCP server,
- data source,
- vector index,
- retrieval corpus,
- evaluation suite,
- deployment,
- runtime,
- secret,
- policy,
- control,
- owner/team,
- business service,
- customer/user group,
- environment.

Each asset must track:

- owner,
- business purpose,
- environment,
- criticality,
- data classification,
- internet exposure,
- model/provider dependencies,
- tool permissions,
- connected data sources,
- last change,
- last eval,
- last incident,
- cost center,
- compliance scope,
- lifecycle state: `discovered`, `reviewed`, `approved`, `deprecated`, `retired`.

Required views:

- asset catalog,
- dependency graph,
- owner map,
- criticality map,
- exposed AI systems,
- unowned assets,
- stale assets,
- high-risk assets,
- assets with missing evals,
- assets with external model routes.

### 51.4 AI Infrastructure Posture Management

Add an AI-SPM layer: continuous security, reliability, quality, and governance posture management for AI systems.

Posture categories:

- Identity and access posture.
- Data exposure posture.
- Model/provider posture.
- Agent/tool posture.
- Prompt and output safety posture.
- Cost and quota posture.
- Reliability and SLO posture.
- Audit and evidence posture.
- Documentation and ownership posture.
- Deployment and change posture.

Posture findings must include:

- severity,
- affected assets,
- evidence,
- policy/control mapping,
- business impact,
- owner,
- remediation,
- auto-fix eligibility,
- exception path,
- due date,
- recurrence count,
- trend.

Example findings:

- AI app uses external provider with confidential data and no approved policy.
- Agent has shell-write capability in production repo without approval gate.
- Prompt template changed without eval run.
- Model route changed after deploy and caused latency regression.
- Vector index contains sensitive documents without label.
- AI workflow has no owner.
- Gateway call volume increased 4x with no linked business event.
- Tool call touched production files outside approved path.
- New model provider appeared in traces but is not in approved inventory.

### 51.5 Control Library For Enterprise AI

Create a built-in control library that maps to AI operations, not generic compliance only.

Control families:

- AI asset inventory.
- AI ownership and accountability.
- Model approval and routing.
- Prompt lifecycle management.
- Tool/function permission management.
- Data source access and sensitivity.
- Retrieval and vector index governance.
- Evaluation and quality gates.
- Human approval and escalation.
- Agent sandboxing and execution boundaries.
- AI supply chain and dependency provenance.
- Cost and quota governance.
- Incident response and postmortems.
- Audit logging and trace completeness.
- Change management and release controls.
- Documentation and runbook freshness.

Each control needs:

- objective,
- applicability,
- test method,
- evidence source,
- pass/fail criteria,
- automation level,
- owner,
- frequency,
- exceptions,
- remediation tasks,
- linked product surfaces.

### 51.6 Policy Simulation And What-If Analysis

Enterprise users need to understand policy impact before enforcement.

Add simulation modes:

- `report-only`: evaluate without blocking.
- `backtest`: run a policy against historical traces and actions.
- `what-if`: preview how a planned action, workflow, or model route would be evaluated.
- `blast-radius`: show affected assets/users/workflows before enabling policy.
- `shadow-enforce`: log what would have been blocked for N days.

Required questions:

- Which runs would this policy block?
- Which teams/assets are affected?
- Which exceptions already exist?
- What would break if enforced today?
- What safer alternative policy can the AI suggest?
- Which controls improve if this policy is enabled?

### 51.7 Remediation Orchestration Center

Auto-fix needs a full remediation lifecycle, not isolated buttons.

Required objects:

- finding,
- recommendation,
- remediation task,
- playbook,
- auto-fix run,
- approval,
- exception,
- verification check,
- rollback action,
- closure evidence.

Remediation states:

- `new`,
- `triaged`,
- `accepted`,
- `planned`,
- `waiting-approval`,
- `running`,
- `verification`,
- `fixed`,
- `exception-granted`,
- `risk-accepted`,
- `failed`,
- `reopened`.

Required views:

- remediation board by severity,
- owner queue,
- auto-fix queue,
- failed remediation queue,
- overdue risks,
- exceptions expiring soon,
- verification needed,
- recently fixed.

Every fix must prove closure:

- before evidence,
- action taken,
- after evidence,
- policy re-evaluation,
- regression check,
- audit record.

### 51.8 AI Build Governance And Release Assurance

The product should not only run Builder. It should govern AI-generated software changes from idea to release.

Add:

- AI-generated change request.
- Plan review gate.
- Code ownership and approval mapping.
- Test/eval requirements per project criticality.
- AI contribution disclosure.
- Generated-code provenance.
- Release readiness score.
- Rollback readiness.
- Production deploy gate.
- Post-release watch window.
- Regression monitoring.

Release readiness must summarize:

- plan completeness,
- tests run,
- evals run,
- files changed,
- sensitive areas touched,
- policies evaluated,
- incidents linked,
- docs updated,
- rollback path,
- owner approval.

### 51.9 Model, Prompt, Tool, And Dataset Lifecycle Management

Add lifecycle management surfaces for the actual components of AI systems.

Model lifecycle:

- requested,
- evaluated,
- approved,
- active,
- probation,
- blocked,
- deprecated,
- retired.

Prompt lifecycle:

- draft,
- reviewed,
- tested,
- approved,
- deployed,
- drifted,
- deprecated.

Tool/function lifecycle:

- discovered,
- permission-scoped,
- tested,
- approved,
- monitored,
- restricted,
- disabled.

Dataset/corpus lifecycle:

- discovered,
- classified,
- indexed,
- approved for retrieval,
- stale,
- access-restricted,
- retired.

Each lifecycle change must include evidence, owner, reason, effective date, and rollback.

### 51.10 Runtime Guardrails And Kill Switches

Enterprise buyers need visible emergency controls.

Add guardrails:

- global external-model kill switch,
- provider kill switch,
- model kill switch,
- agent execution kill switch,
- tool/function kill switch,
- project write-freeze,
- production deploy freeze,
- cost freeze,
- data export freeze,
- maintenance-only mode.

Each kill switch must show:

- scope,
- current state,
- active reason,
- who enabled it,
- expiration,
- affected workloads,
- bypass policy,
- audit history.

The UI must avoid accidental activation: preview, reason, impact, and strong confirmation.

### 51.11 Ownership, RACI, And Business Context

The product cannot be enterprise-grade if every risk is unowned.

Add:

- owner/team directory,
- RACI model per asset/control/policy,
- on-call owner,
- escalation path,
- business service mapping,
- cost center mapping,
- customer impact mapping,
- criticality tiers,
- support window,
- SLA/SLO ownership.

Every finding, incident, report, policy, and remediation task should route to an owner. Unowned critical assets should become high-priority findings.

### 51.12 SLO, SLA, And Reliability Management

Add reliability management for AI infrastructure:

- service-level objectives for AI workflows,
- latency SLOs per model route,
- success-rate SLOs per agent/workflow,
- quality SLOs per eval suite,
- cost SLOs per tenant/project,
- freshness SLOs for data sources/vector indexes,
- trace coverage SLOs,
- audit coverage SLOs,
- evidence freshness SLOs.

SLO views:

- current compliance,
- error budget burn,
- incidents consuming budget,
- recent deploys affecting SLO,
- recommended reliability actions.

### 51.13 AI Supply Chain And Provenance

Add AI supply-chain controls:

- model source provenance,
- model version/hash where available,
- adapter/package dependency inventory,
- prompt template provenance,
- tool/function source provenance,
- MCP server provenance,
- skill/extension signature verification,
- generated-code provenance,
- dataset/vector corpus provenance,
- SBOM for product and agent runtime.

Findings:

- unsigned extension installed,
- unknown MCP server,
- model version changed without approval,
- prompt changed outside release process,
- tool package has known vulnerability,
- generated code lacks trace to plan/run.

### 51.14 Evaluation Lab And Continuous Assurance

The existing model evaluation plan is not enough for a broad enterprise product. Add continuous assurance across apps, prompts, tools, retrieval, and agents.

Required eval types:

- model quality evals,
- prompt regression evals,
- RAG retrieval evals,
- tool-call correctness evals,
- agent task completion evals,
- safety/refusal evals,
- hallucination/citation evals,
- cost/latency evals,
- red-team/adversarial evals,
- production shadow evals.

Evaluation objects:

- dataset,
- rubric,
- judge model,
- deterministic checks,
- threshold,
- owner,
- schedule,
- linked assets,
- release gate.

Every release or route change should answer:

- Did quality improve?
- Did safety degrade?
- Did latency/cost change?
- Which user workflows are affected?
- Should the change be promoted, held, or rolled back?

### 51.15 AI Red Team And Abuse Case Studio

Add an explicit AI risk-testing area.

Capabilities:

- prompt injection test suites,
- data exfiltration simulations,
- malicious tool-call attempts,
- jailbreak regression tests,
- unsafe autonomy tests,
- over-permissioned agent tests,
- retrieval poisoning tests,
- model fallback abuse tests,
- cost-exhaustion simulations.

Outputs:

- red-team finding,
- affected asset,
- reproduced evidence,
- control gap,
- remediation,
- retest result,
- report artifact.

### 51.16 Change, Drift, And Configuration Control

Add drift management beyond timers and config hashes.

Track drift for:

- model route config,
- provider keys metadata,
- gateway policies,
- agent permissions,
- prompt templates,
- tool definitions,
- MCP servers,
- vector index source sets,
- data classifications,
- infrastructure runtime,
- CI/CD settings,
- dashboard policies,
- report schedules.

Views:

- drift since last approved baseline,
- drift by owner/team,
- risky unapproved drift,
- drift correlated with incidents,
- accept baseline action,
- revert or create remediation action.

### 51.17 Executive, Operator, Engineer, Auditor Views

The product should be beautiful and useful for multiple personas.

Views:

- Executive: posture score, business impact, trend, risk accepted, ROI, unresolved criticals.
- Operator: what needs action now, playbooks, alerts, incidents, auto-fixes.
- Engineer: traces, logs, configs, diffs, tests, deploys, evals.
- Auditor: controls, evidence, policy results, exceptions, exports.
- Builder: plans, runs, validations, generated changes, release readiness.
- Security: exposure, secrets, permissions, red-team findings, posture.

Each view uses the same entity graph and evidence store, but different density and language.

### 51.18 Presentation, Animation, And Interaction Quality

The product must feel like a high-end enterprise command center, not a collection of admin tables.

Required presentation patterns:

- animated topology map for AI infrastructure,
- posture score dial with sub-score drilldown,
- timeline ribbon for changes/incidents/deploys/model route changes,
- animated risk propagation across dependency graph,
- live run streams with structured milestones,
- remediation progress tracker,
- evidence drawer with syntax-highlighted logs and redaction chips,
- policy simulator with before/after impact animation,
- model route flow visualization,
- cost and latency sparklines,
- guided setup checklist with progress animation,
- command palette with semantic grouped results.

Motion rules:

- use motion to clarify state transitions, not decoration;
- animate new findings, resolved findings, route changes, and remediation progress;
- provide reduced-motion support;
- keep mobile animations short and non-blocking;
- never hide critical information behind animation.

Visual quality rules:

- every major page starts with an interpreted summary, not raw tables;
- status colors must be consistent and accessible;
- dense data uses progressive disclosure;
- cards must represent real entities or repeated items only;
- charts must explain what changed and why it matters;
- empty states must teach the next setup step.

### 51.19 Tracking, KPIs, And Product Analytics

To sell the product, it must prove operational value.

Track:

- mean time to detect,
- mean time to explain,
- mean time to remediate,
- auto-fix success rate,
- false-positive rate,
- policy coverage,
- trace coverage,
- audit coverage,
- evidence freshness,
- cost saved from routing recommendations,
- incidents prevented by guardrails,
- eval regressions caught before deploy,
- unowned assets over time,
- posture score trend,
- user time-to-first-finding,
- user time-to-first-fix.

Dashboards:

- value delivered,
- risk reduced,
- automation effectiveness,
- governance readiness,
- cost optimization,
- reliability trend,
- adoption and setup completion.

### 51.20 Multi-Environment And Multi-Cloud Support

Support environments and technologies without assuming a single VPS.

Add environment model:

- local,
- development,
- staging,
- production,
- sandbox,
- customer tenant,
- air-gapped,
- cloud-managed.

Support infrastructure scopes:

- single host,
- Docker compose,
- Kubernetes namespace/cluster,
- serverless app,
- managed SaaS AI app,
- CI/CD-only project,
- local developer machine,
- remote agent worker fleet.

Every entity, policy, report, and action must include environment scope and prevent accidental cross-environment mutation.

### 51.21 Enterprise Data Model Additions

Add or reserve schemas for:

- `connectors`
- `connector_sync_runs`
- `assets`
- `asset_links`
- `asset_owners`
- `business_services`
- `posture_findings`
- `posture_scores`
- `control_library`
- `control_tests`
- `control_results`
- `policy_simulations`
- `remediation_items`
- `remediation_runs`
- `exceptions`
- `slos`
- `slo_measurements`
- `baselines`
- `drift_findings`
- `ai_components`
- `prompt_versions`
- `tool_registry`
- `dataset_registry`
- `eval_suites`
- `eval_runs`
- `redteam_runs`
- `kill_switches`
- `release_assurance_reviews`
- `product_kpis`

These schemas should be introduced incrementally, but the naming and relationships should be stable early so connectors and reports do not need rewrites.

### 51.22 Sellable Product Acceptance Gate

The product is enterprise-sellable only when:

- a new customer can connect at least one AI system and get useful findings in under 10 minutes;
- the system inventories AI assets across at least three source types;
- every finding maps to owner, evidence, policy/control, and remediation;
- a policy can be simulated before enforcement;
- an eval suite can gate a model/prompt/tool release;
- remediation can be tracked from finding to verified closure;
- executive/operator/engineer/auditor views all use the same evidence base;
- connectors degrade honestly and show setup gaps;
- posture score changes are explainable;
- kill switches exist for high-risk AI autonomy and external provider use;
- beautiful motion and visual hierarchy make complex infrastructure understandable;
- reports can prove value, risk reduction, and audit readiness.

### 51.23 Priority Insertions

Insert these into the roadmap:

1. After entity foundation: build AI asset inventory and connector registry.
2. After detection foundation: build posture findings and posture score.
3. After action foundation: build remediation lifecycle and verification.
4. Before governance controls: build policy simulation and backtesting.
5. Before Builder/Brainstormer GA: add release assurance and eval gates.
6. Before packaging: add first-run immediate-value landing, setup progress, and persona views.
7. Before enterprise launch: add red-team studio, SLOs, drift baselines, kill switches, and value analytics.


<!-- Builder run br_631df: success at 2026-05-18T04:19:31.940Z — details: /opt/ai-vault/builder/2026-05-18-bw_0696e-br_631df.md -->

<!-- Builder run br_8b7ba: failed at 2026-05-18T04:47:52.900Z — details: /opt/ai-vault/builder/2026-05-18-bw_ae3d0-br_8b7ba.md -->

<!-- Builder run br_06485: failed at 2026-05-18T05:13:37.461Z — details: /opt/ai-vault/builder/2026-05-18-bw_bc3db-br_06485.md -->

<!-- Builder run br_c6100: success at 2026-05-18T05:27:47.480Z — details: /opt/ai-vault/builder/2026-05-18-bw_22c9b-br_c6100.md -->

<!-- Builder run br_a48f8: success at 2026-05-18T05:36:47.473Z — details: /opt/ai-vault/builder/2026-05-18-bw_dcfba-br_a48f8.md -->

<!-- Builder run br_0fc27: success at 2026-05-18T05:52:08.044Z — details: /opt/ai-vault/builder/2026-05-18-bw_e0c96-br_0fc27.md -->

<!-- Builder run br_c7361: success at 2026-05-18T06:03:07.884Z — details: /opt/ai-vault/builder/2026-05-18-bw_c30be-br_c7361.md -->

<!-- Builder run br_bee11: success at 2026-05-18T06:10:19.029Z — details: /opt/ai-vault/builder/2026-05-18-bw_5cede-br_bee11.md -->

<!-- Builder run br_c308f: failed at 2026-05-18T06:28:58.232Z — details: /opt/ai-vault/builder/2026-05-18-bw_a044f-br_c308f.md -->

<!-- Builder run br_661bc: success at 2026-05-18T06:43:48.390Z — details: /opt/ai-vault/builder/2026-05-18-bw_987e1-br_661bc.md -->

<!-- Builder run br_10c4f: success at 2026-05-18T06:49:17.072Z — details: /opt/ai-vault/builder/2026-05-18-bw_5b6a7-br_10c4f.md -->

<!-- Builder run br_9a219: success at 2026-05-18T07:01:28.669Z — details: /opt/ai-vault/builder/2026-05-18-bw_d29f3-br_9a219.md -->

<!-- Builder run br_af338: success at 2026-05-18T07:13:14.859Z — details: /opt/ai-vault/builder/2026-05-18-bw_ad82a-br_af338.md -->

<!-- Builder run br_f6e5a: success at 2026-05-18T07:23:12.003Z — details: /opt/ai-vault/builder/2026-05-18-bw_66725-br_f6e5a.md -->

<!-- Builder run br_465bf: success at 2026-05-18T07:32:05.414Z — details: /opt/ai-vault/builder/2026-05-18-bw_de25f-br_465bf.md -->
## Bug Fixes Required (implement immediately)

- [x] Fix `readBuilderDoctorReports()` in `server/builder/store.ts` (~line 740): `conditions` array gets empty string pushed when `tenantWhere.clause` is empty (mimule tenant), causing `WHERE AND ...` SQL syntax error. Fix: add guard `const clauseStr = tenantWhere.clause.trim().replace(/^ AND /, ""); if (clauseStr) conditions.push(clauseStr);` and change the WHERE append to only fire when `conditions.length > 0`. Verify by running `bun run typecheck` and checking journalctl no longer shows `SQLiteError: near "AND": syntax error`.
- [x] Fix `builderArtifactContentHandler()` in `server/api/builder.ts` (~line 115): log files are looked up at flat path `/var/lib/control-surface/builder-runs/${runId}/pass-X-stderr.log` but tenant-aware runs are stored at `/var/lib/control-surface/tenants/{tenantId}/projects/{projectId}/builder-runs/${runId}/`. Fix: after the flat path `existsSync` check fails, compute the tenanted path using `getCurrentTenantContext()` and the project root from the run record (query `builder_runs` table for the run's `project_id`, then look up `builder_projects` for its `root`, then build the tenanted path as `CONTROL_SURFACE_DATA_DIR/tenants/${tenantId}/projects/${projectId}/builder-runs/${runId}/`). Verify by calling `GET /api/builder/log?runId=<recent-run-id>&kind=stderr&pass=1` and confirming it returns log content (not 404).


<!-- Builder run br_ddb0c: success at 2026-05-18T07:48:07.066Z — details: /opt/ai-vault/builder/2026-05-18-bw_eaa04-br_ddb0c.md -->

<!-- Builder run br_b213e: success at 2026-05-18T08:14:58.805Z — details: /opt/ai-vault/builder/2026-05-18-bw_449b3-br_b213e.md -->