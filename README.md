# TIB Control Surface

TIB Control Surface is an operator console for AI-assisted software and editorial systems. It brings agent sessions, model routing, workflow automation, service health, cost, governance, and evidence into one web application.

The production operator surface is available at [control.techinsiderbytes.com](https://control.techinsiderbytes.com). It requires authentication; do not treat the hostname as a public API contract.

The project is designed for operators who need to answer practical questions quickly:

- What is running, waiting, failing, or blocked?
- Which model and provider handled a request, and why?
- Is a failure caused by the model, its credential, the provider, or the local host?
- What did an agent change, which checks passed, and where is the evidence?
- Which action is safe to automate, and which action still needs approval?
- Can a long-running task survive a browser refresh or another agent taking over?

The Control Surface is not itself an AI model and it is not a replacement for every underlying service. It is the control plane that connects those services and makes their state understandable and actionable.

## Project goals

- Provide one coherent operating view instead of a collection of unrelated dashboards.
- Make AI work durable: plans, sessions, runs, artifacts, validation, and continuation state should survive handoffs.
- Route model requests by explicit policy, health, cost, and capability rather than by guesswork.
- Prefer healthy local or free capacity while keeping measured fallbacks available.
- Separate model health from credential health so an expired key does not make a good model look permanently broken.
- Keep risky operations behind authentication, policy, approval, and an audit trail.
- Correlate workflow, model, terminal, cost, and infrastructure evidence wherever the adapters expose it.
- Show degraded or unavailable integrations honestly; do not replace missing evidence with demo data in normal operation.

## What is implemented today

The repository contains a React operator interface and a Bun server. Major implemented areas include:

| Area | What it does |
|---|---|
| Home and Admin | Summarize health, activity, incidents, recommendations, and searchable operational state |
| Builder | Define and run multi-pass agent workflows, preserve plans and artifacts, validate passes, pause, resume, retry, and reconcile interrupted work |
| Agents | Run and inspect Codex, OpenCode, Claude, and Gemini sessions through separate adapters and pages |
| Terminal | Attach an authenticated operator to one persistent, tmux-backed root terminal session |
| Models | Combine configured models with model-health, credential-health, quality, cooldown, routing, and promotion evidence |
| Gateway | Expose OpenAI-compatible model endpoints, route through fallback chains, manage circuit state and route overrides, and record usage |
| Cost | Report usage, estimated spend, fallback behavior, budgets, attribution, and recommendations when the required data exists |
| Governance | Load policy, enforce roles and approvals, manage secret references, retention, budgets, and action audit records |
| Reasoner and Insights | Turn observed failures and anomalies into diagnoses, incidents, playbooks, and reviewable remediation suggestions |
| Traces and Audit | Correlate Builder spans, gateway attempts, action history, validation artifacts, and exportable evidence |
| Operations | Inspect infrastructure, scheduled work, jobs, channels, reports, content health, and connected product services |
| Platform | Support projects, tenants, marketplace skills, feature flags, licensing, onboarding, telemetry consent, and compliance views |

Some pages depend on services or files outside this repository. A page may therefore be fully implemented but show a degraded state when LiteLLM, OpenCode, a model-health artifact, a database, or another adapter is unavailable. That distinction is intentional.

## How the system fits together

```text
Browser
   |
   | authenticated HTTP, SSE, or WebSocket
   v
Bun server and API router
   |
   +-- Builder runner -------- agent adapters and validation commands
   +-- Gateway --------------- model policy, fallback chains, circuits
   +-- Service adapters ------- OpenCode, LiteLLM, content, host services
   +-- Governance ------------ roles, approvals, budgets, retention
   +-- Reasoner -------------- diagnoses, incidents, playbooks
   +-- Persistence ----------- SQLite, JSON artifacts, traces, receipts
   |
   v
React operator interface
```

There are two important request paths:

1. **Control requests** operate the platform: start a workflow, acknowledge an incident, change a route override, or open an agent session. They pass through operator authentication, tenant context, action policy, and audit boundaries where applicable.
2. **Model requests** ask an LLM to do work. Requests sent to the Control Surface gateway use its routing, key, circuit, ledger, and tracing logic. Some external CLI adapters can also call their own provider directly; the UI should identify that path instead of implying it used the gateway.

## Core concepts

### Project, workflow, run, and pass

A **project** identifies a repository or operating workspace. A **workflow** is a reusable definition of work. Starting a workflow creates a **run**. A run is divided into ordered **passes**, usually one agent task at a time.

Each pass may define:

- an agent harness such as OpenCode, Codex, or Claude;
- a prompt and optional model policy;
- validation commands and timeouts;
- retry and continuation behavior;
- git, backup, and risk controls;
- artifacts that later passes or operators can inspect.

The runner persists lifecycle state. It can continue a plan across passes, stop after a safe boundary, reconcile work after a process restart, and fail closed when required validation does not pass.

### Session, model route, and provider

An agent **session** is an interactive conversation or command runtime. A **model route** is the name a client requests. A **provider model** is the concrete backend that ultimately receives a call.

These names are deliberately separate. A logical route can point to a local model today and a cloud fallback tomorrow without requiring every client to change. The route decision should remain visible in the usage ledger and trace evidence.

### Health, quality, and credentials

Model status is derived from several signals rather than one boolean:

- the latest bounded probe result;
- recent and all-time call success;
- credential validity and expiry evidence;
- provider and infrastructure errors;
- cooldown or reprobe state;
- quality policy and promotion gates;
- the age and completeness of the source artifact.

This matters because “the request failed” does not necessarily mean “delete the model.” An expired key, a temporary rate limit, a provider outage, or a local tunnel problem needs a different response. Temporarily blocked routes can be given bounded redemption probes; promotion back into normal traffic requires positive evidence rather than the passage of time alone.

### Audit, trace, and receipt

An **audit record** says that an operator or system actor requested an action. A **trace** connects related work across Builder and gateway attempts. A **receipt** is stronger evidence produced by a specific validation or operational action.

The project keeps these concepts separate so a UI click, a model call, a validation result, and a deployment observation are not collapsed into one vague “success” state.

## Model routing logic

The Control Surface gateway provides `POST /v1/chat/completions` and `GET /v1/models`. Its routing flow is:

1. Authenticate the caller as an operator or gateway-key consumer, depending on the route.
2. Resolve the requested logical model from gateway configuration.
3. Enforce the key's model allowlist and daily cap when a gateway key is used.
4. Check route overrides and circuit state.
5. Attempt the primary backend, then eligible fallbacks in order.
6. Keep one trace identifier across all attempts in the same request.
7. Record model, backend, success, latency, token/cost data when available, and a normalized error class.
8. Return the successful response or an explicit failure when no eligible route succeeds.

The Models and LiteLLM pages also read external health and routing artifacts. Those files are treated as evidence with timestamps, not as timeless truth. Missing or stale artifacts are shown as degraded.

## Builder logic

Builder is the durable automation engine:

```text
workflow definition
      |
      v
create run -> select next pass -> launch adapter -> capture output
      ^                                                |
      |                                                v
pause/resume <- persist state <- validate artifacts and commands
                                      |
                           pass, retry, stop, or complete
```

A typical development workflow is plan, implement, review, and validate. Builder can schedule or auto-continue work, but automation does not remove the configured risk gates. A workflow is complete only when its plan and acceptance conditions say it is complete, not merely because the maximum pass count was reached.

See [Builder concepts](docs/concepts/builder.md) and the [workflow definition](docs/workflow-definition.md).

## Governance and action safety

The server distinguishes reading state from changing state. Mutating APIs are checked against authentication, tenant context, role and policy requirements, and the shared audit boundary. Higher-risk operations can require a separate approval.

Important boundaries:

- `OPERATOR_TOKEN` is a bootstrap credential and must stay on the server.
- Browser authentication uses an HttpOnly session cookie.
- Gateway Bearer keys use a separate `gwk_*` namespace and must not be confused with the operator token.
- Secret APIs list references or names; values must not be returned to normal browser state.
- The root terminal has stricter authentication than ordinary dashboard reads.
- A route override, retry, restart, deployment, or deletion is an action with audit evidence, not a harmless UI preference.

For local automation, send the operator token in `x-operator-token`:

```bash
curl -H "x-operator-token: $OPERATOR_TOKEN" \
  http://localhost:3000/api/builder/workflows
```

Do not put real credentials in command history, documentation, issue text, screenshots, or committed environment files.

## Agent pages and terminal

The current release has separate routes for OpenCode, Codex, Claude, Gemini, and Terminal.

- Each agent page uses its own server adapter and session store.
- OpenCode has a protected proxy for its server API.
- Codex, Claude, and Gemini expose session lifecycle and streaming endpoints.
- The Terminal page uses xterm in the browser and a Bun WebSocket on the server.
- The terminal server currently attaches clients to one configured tmux session. It is persistent across browser disconnects, but it is not yet a true multi-session terminal manager.

These pages are useful today, but their session state, controls, and trace behavior are not yet unified. See the roadmap below for the proposed replacement.

## All-in-one Agent Workspace roadmap

The planned Agent Workspace is **not shipped yet**. Its design brief lives outside this runtime repository in `control-surface-plans/ALL_IN_ONE_AGENT_WORKSPACE_PLAN.md` in the operations/planning repository.

The proposal combines Terminal, Codex, OpenCode, Claude, and Gemini into one persistent workspace while keeping a real adapter for each harness. Planned capabilities include:

- multiple terminal and agent sessions that remain alive while the operator navigates elsewhere;
- tabs, splits, a collapsible global session dock, reconnect, archive, fork, and handoff;
- project, repository, branch, worktree, isolation, and permission context for every session;
- exact-model, fallback, automatic, and comparison routing modes;
- capability-aware inference controls such as reasoning effort, variant, temperature, output limits, tools, network, sandbox, and approvals;
- one normalized timeline for prompts, tool calls, commands, diffs, checkpoints, route attempts, tokens, cost, and artifacts;
- Markdown, JSONL, and telemetry exports built from redacted evidence;
- the same session registry and lifecycle operations in both GUI and CLI.

The first planned delivery slice is a server-side visibility invariant for OpenCode probe sessions. Internal test sessions must be excluded before serialization from normal lists, counts, search, recents, restored state, notifications, and analytics. Hiding is not deletion: audit evidence remains available only through an explicit root diagnostic path. Until that slice and its tests ship, this behavior must not be described as complete.

## Quick start

### Requirements

- [Bun](https://bun.sh/) 1.3 or newer;
- Git;
- enough memory for TypeScript and the production build;
- OpenCode Server for OpenCode session features;
- tmux for the root terminal;
- LiteLLM or another configured backend for external model-routing data.

The last three integrations are optional for starting the web server, but their related pages will show unavailable or degraded state without them.

### Install dependencies

```bash
git clone https://github.com/7empes7s/opencode-control-surface.git
cd opencode-control-surface
bun install
cp .env.example .env
```

Set at least a long random `OPERATOR_TOKEN`. Do not commit `.env`.

### Run the complete application locally

The most representative local run is a production-style build and server:

```bash
bun run check
PORT=3000 \
OPERATOR_TOKEN="$OPERATOR_TOKEN" \
OPENCODE_SERVER_URL=http://localhost:4096 \
DASHBOARD_DB=1 \
DASHBOARD_DB_PATH="$PWD/.local/dashboard.sqlite" \
OBSERVABILITY_DB_PATH="$PWD/.local/observability.sqlite" \
bun run start
```

`bun run start` records the current commit, short build hash, and UTC build time in the running version metadata.

Verify the server and build identity:

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/api/version
```

`/api/version` should report production mode and real commit metadata when the application is started from a git checkout.

### Front-end development

```bash
bun run dev
```

This starts Vite with hot module replacement. It is useful for UI work, but the Vite configuration only proxies the OpenCode development path. Features that depend on the Control Surface API need a compatible API endpoint or a production-style local run.

### Demo data

Set `DEMO_SEED=1` only for a disposable showcase database. It populates a demo tenant with representative Builder, audit, reasoner, cost, and agent data. Never enable demo seeding against a production database.

## Configuration

The checked-in `.env.example` documents the smallest setup. The server supports additional integration-specific variables.

| Variable | Purpose | Default or behavior |
|---|---|---|
| `PORT` | HTTP server port | `3000` |
| `OPERATOR_TOKEN` | Bootstrap operator authentication | Required for normal production operation and root terminal access |
| `OPERATOR_SESSION_SECRET` | Signs operator sessions | Configure a stable secret in production |
| `OPENCODE_SERVER_URL` | OpenCode Server base URL | `http://localhost:4096` |
| `DASHBOARD_DB` | Enables the main durable SQLite store | Set to `1` to enable |
| `DASHBOARD_DB_PATH` | Main SQLite path | `/var/lib/control-surface/dashboard.sqlite` |
| `OBSERVABILITY_DB_PATH` | Observability SQLite path | `/var/lib/control-surface/observability.db` |
| `LITELLM_URL` | Connected LiteLLM API | Integration-dependent |
| `DASHBOARD_MODEL_HEALTH_PATH` | Model probe artifact | `/var/lib/mimule/model-health.json` |
| `DASHBOARD_CREDENTIAL_HEALTH_PATH` | Credential health artifact | Integration-dependent |
| `DASHBOARD_REPROBE_STATE_PATH` | Model redemption/reprobe state | Integration-dependent |
| `DASHBOARD_TERMINAL_SESSION` | Current single tmux session name | `tib-root` |
| `BUILDER_STATE_ROOT` | Builder state and artifact root | Integration-dependent |
| `DEMO_SEED` | Adds disposable showcase data at boot | Off unless set to `1` |

Use root-readable environment files or a secret manager in production. Environment examples should contain names and placeholders only.

## API overview

Most application routes live under `/api/`. Core gateway, governance, licensing, telemetry, and onboarding routes also have a versioned `/v1/` mapping. The OpenAI-compatible model surface uses `/v1/chat/completions` and `/v1/models`.

Representative endpoints:

```text
GET    /api/version
GET    /api/home
GET    /api/admin/health

GET    /api/builder/workflows
POST   /api/builder/workflows
POST   /api/builder/workflows/:id/start
GET    /api/builder/runs/:id
GET    /api/builder/artifacts

GET    /api/models
GET    /api/gateway/status
GET    /api/gateway/models
GET    /api/gateway/ledger
GET    /api/gateway/stats
POST   /api/gateway/probe

POST   /v1/chat/completions
GET    /v1/models

GET    /api/governance/policies
GET    /api/governance/approvals
GET    /api/actions/audit
GET    /api/traces
GET    /api/traces/gateway

GET    /api/codex/sessions
GET    /api/claude/sessions
GET    /api/gemini/sessions
GET    /api/terminal/status
```

See the [API reference](docs/reference/api.md) for request and response details. The router source remains authoritative when documentation and a deployed commit disagree.

## Testing and validation

### Required code check

```bash
bun run check
```

This runs TypeScript without emitting files and then builds the production bundle. The script gives Node a 4 GB heap. If the host is constrained, run the check in a suitably sized development or CI environment.

### Tests

Run the repository test suite with the dashboard database enabled:

```bash
DASHBOARD_DB=1 bun test
```

For a faster backend-focused pass:

```bash
DASHBOARD_DB=1 bun test \
  server/db/ \
  server/api/ \
  server/tenancy/ \
  server/orchestrator/ \
  server/marketplace/ \
  server/licensing/ \
  server/telemetry/
```

End-to-end tests use Playwright:

```bash
bun run test:e2e
```

Run browser tests in a controlled development or staging environment, not against a production operator session. Fresh-host and repair-arc checks have additional scripts and evidence requirements under `e2e/` and `scripts/`; use the corresponding task specification before treating their output as acceptance evidence.

Always finish with:

```bash
git diff --check
git status --short
```

## Production deployment

The repository includes both systemd and Docker assets:

- `installer/systemd/control-surface.service`
- `installer/docker/Dockerfile`
- `installer/docker/compose.yaml`
- `installer/install.sh`

A source-checkout deployment is typically:

```bash
bun install
bun run check
systemctl restart control-surface.service
curl -s http://localhost:3000/health
curl -s http://localhost:3000/api/version
```

Use the deployment method and service name defined by the target environment. A reverse proxy may expose the application, but the Bun server should remain bound and firewalled according to that environment's security policy. Do not copy example hostnames, tokens, or database paths blindly.

For binary or release deployments outside a git checkout, set `BUILD_COMMIT`, `BUILD_HASH`, and `BUILD_TIME` so `/api/version` can identify the deployed build.

## Project structure

```text
app/
  components/       shared UI, tables, drawers, agent controls
  hooks/            API, authentication, streaming, sorting, voice
  routes/           operator pages, including agents and terminal
  globals.css       design tokens and global styles

server/
  api/              HTTP handlers and the central route map
  adapters/         OpenCode, models, pipelines, host and service reads
  builder/          workflow runner, store, discovery, validation, doctor
  gateway/          routing, provider adapters, keys, circuits, ledger
  governance/       policies, approvals, audit, retention, RBAC
  reasoner/         diagnoses, incidents, playbooks, lifecycle
  orchestrator/     durable lanes, signals, and instances
  tracing/          spans and JSONL export
  terminal/         authenticated tmux-backed WebSocket terminal
  db/               SQLite schema, migrations, ingestion, sampling
  tenancy/          tenant context and isolation
  marketplace/      skill manifests, registry, execution

docs/               concepts, API, operations, tutorials, compliance
e2e/                browser, fresh-host, and demo evidence harnesses
examples/           sample Builder workflows
installer/          source, systemd, Docker, and binary install assets
scripts/            smoke checks, probes, validation receipts, verifiers
sdk/                JavaScript and TypeScript client surface
```

## Documentation

- [Quick start guide](docs/quickstart.md)
- [Builder concepts](docs/concepts/builder.md)
- [Gateway concepts](docs/concepts/gateway.md)
- [Governance concepts](docs/concepts/governance.md)
- [Reasoner concepts](docs/concepts/reasoner.md)
- [Workflow definition](docs/workflow-definition.md)
- [API reference](docs/reference/api.md)
- [CLI reference](docs/reference/cli.md)
- [Backup and restore](docs/operations/backup-restore.md)
- [Troubleshooting](docs/operations/troubleshooting.md)
- [Upgrade guide](docs/operations/upgrade.md)
- [Changelog](docs/changelog.md)

## Documentation rules

- Describe current behavior separately from roadmap behavior.
- Prefer plain language and concrete examples.
- Verify routes, commands, file paths, and environment names against the current tree.
- Never include real credentials, private endpoints, personal identifiers, or copied provider response bodies.
- When a claim depends on an external service, name the dependency and its evidence timestamp.
- Update the relevant plan and AI vault log after meaningful implementation or operational work.
- Keep commits focused so documentation, code, and deployment evidence can be reviewed independently.

## License

MIT
