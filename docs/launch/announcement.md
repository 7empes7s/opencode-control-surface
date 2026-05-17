# OpenCode Control Surface v1.0 — Launch Announcement

*Draft for HN / blog post*

---

## We built an AI operations center. Then we dogfooded it for 12 months to build our entire media company with it.

Today we're releasing the OpenCode Control Surface as a standalone product: a programmable AI operations platform for teams that run AI agents in production.

**TL;DR**: It's a dashboard + API + workflow engine that gives you visibility and control over every AI agent, model, and pipeline in your stack — with the operational rigor you'd expect for any critical infrastructure.

---

## What it does

The control surface sits between your AI agents (OpenCode, Codex, Claude Code) and the outside world. It handles:

- **Orchestration** — Define multi-pass AI workflows in YAML. Chain agents, validate outputs between passes, roll back on failure.
- **Model routing** — Route requests across local GPU, cloud LLMs, and fallback chains. The system picks the fastest available model and tracks cost.
- **Observability** — Live dashboard with SSE streaming. Incident timeline. GPU health. Pipeline throughput per vertical.
- **Governance** — Immutable audit log. OIDC/SSO. Configurable data retention. Structured error responses (no stack traces in production).
- **Auto-repair** — Anomaly detection triggers playbooks that can auto-remediate — restart stalled jobs, switch models, notify on-call.

---

## Why we built it

Twelve months ago, we started building a lean media company (TechInsiderBytes) with a skeleton crew and too much infrastructure. We had:

- A Next.js news site with an editorial pipeline
- A Telegram bot (Mimule) running on a $20/mo VPS
- A GPU server on Vast.ai for inference
- A growing pile of scripts held together with cron jobs and hope

The problem wasn't AI capability. The problem was *operational*: knowing what was running, what had failed, what model was being used, whether the pipeline was healthy, who approved what, and what to do when something broke at 2am.

So we built the control surface to solve our own problem. Then we used it to rebuild everything — including itself.

---

## How to get started

### Option 1: Web UI (no install)

```
https://control.techinsiderbytes.com
```

Point it at your OpenCode server, configure your model endpoints, and the dashboard lights up.

### Option 2: CLI

```bash
curl -L https://control.techinsiderbytes.com/install.sh | bash
builder --version
# → builder/1.0.0 linux-x64

builder discover   # find running agents
builder run --workflow examples/hello-builder/workflow.yaml
```

### Option 3: API

```bash
export BUILDER_HOST="https://control.techinsiderbytes.com"
export BUILDER_TOKEN="your-token"

# list workflows
curl $BUILDER_HOST/api/builder/workflows \
  -H "Authorization: Bearer $BUILDER_TOKEN"

# trigger a run
curl -X POST $BUILDER_HOST/api/builder/workflows/$ID/start \
  -H "Authorization: Bearer $BUILDER_TOKEN"
```

---

## What's in v1.0

- Stable v1 API with 12-month deprecation windows on breaking changes
- `/v1/` prefix aliases for all core routes
- 8 example workflows (hello-builder, scheduled-doctor, multi-agent-pipeline, ...)
- Full HTTP API reference and CLI reference
- Compliance docs: DPA, security overview, SOC2-style control mapping
- 3 case studies: NewsBites V4, TIB Markets, self-bootstrapping

---

## What we're working on next

v1.1 is focused on three things:

1. **Skill bundles** — Package, sign, and distribute reusable workflow templates via a manifest format
2. **Approval gates** — Human-in-the-loop checkpoints for high-risk workflow stages
3. **Multi-region fallback** — Run the same workflow against GPU endpoints in two regions simultaneously; pick the first valid result

---

## Who it's for

- **Platform teams** at startups running 3+ AI agents in production
- **Solo operators** who want operational rigor without hiring an SRE
- **AI-native startups** who need audit trails for compliance (SOC2, HIPAA, GDPR)

---

## Get involved

We are looking for **5 design partners** to shape v1.1. If you're running AI infrastructure and want a voice in the roadmap, see [design-partner-outreach.md](./design-partner-outreach.md).

Questions? Open an issue at the GitHub repo or reach out via the links at [control.techinsiderbytes.com](https://control.techinsiderbytes.com).