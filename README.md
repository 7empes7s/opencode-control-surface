# TIB Control Surface — v1.0

An operator control plane for AI-powered development pipelines. Manages multi-agent builder workflows, model gateway routing, governance policies, marketplace skills, and observability — all from a single responsive web UI.

Live at [control.techinsiderbytes.com](https://control.techinsiderbytes.com).

---

## What it does

| Pillar | What it gives you |
|---|---|
| **Builder** | Durable multi-pass workflow engine — schedule, monitor, and auto-continue agent runs across Codex, Claude, OpenCode, and Gemini |
| **Gateway** | Model routing with circuit breakers, per-model usage ledger, and cost tracking across LiteLLM, OpenRouter, and local GPU |
| **Governance** | Policy documents, secrets vault, 4-eyes approval gates, budget caps, and audit chain |
| **Marketplace** | Skill bundle registry — install, enable, and run signed skill packages |
| **Telemetry** | Opt-in usage telemetry with payload preview before shipping |
| **Licensing** | Solo / Team / Enterprise / Cloud tier gating with HMAC-signed license keys |
| **Tracing** | Span-level trace viewer for builder runs and pipeline events |
| **Compliance** | SOC2-aligned controls, data residency, DPA overview, audit export |
| **Onboarding** | Guided install wizard with step-by-step validation |

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.3+
- OpenCode server (`opencode serve`)
- LiteLLM proxy (optional — for model routing)

### Install

```bash
git clone https://github.com/7empes7s/opencode-control-surface
cd opencode-control-surface
bun install
cp .env.example .env   # fill in OPERATOR_TOKEN and OPENCODE_SERVER_URL
bun run dev            # dev server on :5173
```

### Production

```bash
bun run build
PORT=3000 OPERATOR_TOKEN=your-token OPENCODE_SERVER_URL=http://localhost:4096 \
  DASHBOARD_DB=1 bun run server/index.ts
```

Or use the included installer:

```bash
bash installer/install.sh
```

### Docker

```bash
docker compose -f installer/docker/compose.yaml up -d
```

---

## Configuration

Copy `.env.example` to `.env`:

```
OPENCODE_SERVER_URL=http://localhost:4096
OPERATOR_TOKEN=generate-a-long-random-token
DASHBOARD_DB=1
DASHBOARD_DB_PATH=~/.config/control-surface/dashboard.db
LITELLM_URL=http://localhost:4000          # optional
BUILDER_LICENSE_PATH=~/.builder/license.key  # optional
```

`OPERATOR_TOKEN` is never sent to the browser. The server issues an HttpOnly same-site session cookie after the operator authenticates at `/api/auth/session`.

---

## API

All routes are under `/api/`. A stable `/v1/` prefix is available for core routes.

```
GET  /api/version                  → { version, buildHash, apiVersion }
GET  /api/builder/workflows        → workflow list
POST /api/builder/workflows        → create workflow
POST /api/builder/workflows/:id/start
GET  /api/gateway/stats            → model usage + cost ledger
GET  /api/governance/policies      → loaded policy documents
GET  /api/licensing/status         → current tier + features
GET  /api/telemetry/preview        → payload preview (opt-in)
POST /api/telemetry/consent        → set opt-in/out
GET  /api/onboarding/status        → wizard state
POST /api/onboarding/step          → advance wizard step
```

Full reference: [`docs/reference/api.md`](docs/reference/api.md)

---

## Builder Pipeline

The Builder is the core automation primitive. A **workflow** defines:
- `agentOrder` — which agents run in sequence (opencode, codex, claude, gemini)
- `modelPolicy` — primary model + fallback chain
- `mode` — `once` | `auto-continue` | `scheduled` | `permanent`
- `planFile` — markdown file with `- [ ]` checkboxes tracking progress
- `validationProfile` — shell commands that must pass after each agent pass
- `riskPolicy` — max passes, pass timeout, live-deploy gate

The runner executes passes, captures stdout/stderr, runs validation, and marks the plan file. If all checkboxes are checked after a pass, the run terminates as `success` regardless of remaining `maxPasses`.

```bash
# Start a workflow run via API
curl -s -X POST http://localhost:3000/api/builder/workflows/bw_xxx/start \
  -H "Cookie: operator_session=..." \
  -H "Content-Type: application/json" -d '{}'
```

See [`docs/concepts/builder.md`](docs/concepts/builder.md) for full documentation.

---

## Licensing

Without a license file, the server starts in **solo** tier (all local features enabled). Team and Enterprise tiers unlock SSO, 4-eyes approval, audit export, and data residency controls.

```bash
# Check current tier
curl http://localhost:3000/api/licensing/status
# → { "tier": "solo", "features": [...], "expiresAt": null }
```

---

## Development

```bash
bun run dev          # Vite + server with HMR
bun run typecheck    # tsc --noEmit
bun run build        # production build to dist/

# Tests (requires DASHBOARD_DB=1)
DASHBOARD_DB=1 bun test server/db/ server/api/ server/tenancy/ \
  server/orchestrator/ server/marketplace/ server/licensing/ server/telemetry/
```

Test baseline: **260 pass / 0 fail** (2026-05-17).

---

## Project Structure

```
├── app/
│   ├── components/          # Shared UI (DashHeader, DashSidebar, WCard, Pill…)
│   ├── hooks/               # useApi, useTableSort, useTenantContext…
│   ├── routes/              # Page components (one per route)
│   └── globals.css          # OKLCH design-token system + utility classes
├── server/
│   ├── api/                 # HTTP route handlers
│   ├── builder/             # Workflow engine (runner, store, discovery, doctor)
│   ├── gateway/             # Model router + cost ledger
│   ├── governance/          # Policy, secrets, approvals, budgets, RBAC
│   ├── marketplace/         # Skill bundle loader + registry
│   ├── licensing/           # License key verification + feature gates
│   ├── telemetry/           # Opt-in usage telemetry
│   ├── orchestrator/        # Lane-based workflow orchestration
│   ├── reasoner/            # Anomaly detection + playbooks
│   ├── tenancy/             # Multi-tenant context + isolation
│   ├── tracing/             # Span exporter
│   ├── compliance/          # Audit chain + retention
│   ├── sso/                 # SSO integration stubs
│   └── db/                  # SQLite schema + migrations + sampler
├── docs/
│   ├── quickstart.md
│   ├── concepts/            # builder, gateway, governance, reasoner
│   ├── reference/           # api, cli, skill-manifest
│   ├── operations/          # backup-restore, upgrade, troubleshooting
│   ├── compliance/          # dpa, security-overview, control-mapping
│   ├── case-studies/        # newsbites-v4, tib-markets, self-bootstrapping
│   └── launch/              # announcement, video walkthrough, outreach
├── examples/
│   ├── hello-builder/       # Minimal one-pass workflow
│   ├── scheduled-doctor/    # Nightly doctor review
│   └── multi-agent-pipeline/ # 3-pass plan → build → review
├── installer/
│   ├── install.sh
│   ├── docker/
│   └── systemd/
└── sdk/                     # Embeddable JS/TS SDK
```

---

## Docs

- [Quickstart](docs/quickstart.md)
- [Builder concepts](docs/concepts/builder.md)
- [Gateway concepts](docs/concepts/gateway.md)
- [Governance concepts](docs/concepts/governance.md)
- [API reference](docs/reference/api.md)
- [CLI reference](docs/reference/cli.md)
- [Upgrade guide](docs/operations/upgrade.md)
- [Changelog](docs/changelog.md)

---

## Deployment

Add to your Caddyfile:

```
control.example.com {
  reverse_proxy localhost:3000
}
```

Or use Cloudflare Tunnel for external access without opening firewall ports.

---

## License

MIT
