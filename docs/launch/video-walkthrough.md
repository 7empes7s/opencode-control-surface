# Video Walkthrough — OpenCode Control Surface v1.0

**Target length**: 8–12 minutes  
**Audience**: Developers and platform engineers evaluating the control surface  
**Tone**: Confident, technical, not salesy

---

## Scene 1 — Title (30 sec)

**[SCREEN: Dark navy dashboard with live UTC clock, "live" indicator pulsing]**

Voiceover: "This is the OpenCode Control Surface. It's an operations platform for AI infrastructure — giving you a single place to see, orchestrate, and govern every AI agent and model in your stack."

**[TITLE CARD: OpenCode Control Surface — v1.0]**

---

## Scene 2 — The Problem (60 sec)

**[SCREEN: Text animate in, no dashboard]**

Voiceover: "If you're running AI agents in production today, you probably have a mess of scripts, cron jobs, and Slack alerts — with no single place to see what's actually happening."

Cut to: quick montage of scattered terminal windows, a Notion doc with "GPU is down again" in red, a Slack message saying "who restarted the pipeline?"

Voiceover: "We built the control surface because we lived this. Running a lean media company with AI agents, a GPU server in the cloud, a Telegram bot, and an editorial pipeline — and no idea what was broken until a reader emailed us."

---

## Scene 3 — Install + First Run (90 sec)

**[SCREEN: Terminal window, clean dark theme]**

```bash
curl -L https://control.techinsiderbytes.com/install.sh | bash
builder --version
# builder/1.0.0 linux-x64
```

Voiceover: "Install takes under a minute. The CLI is a single binary — or you can use the web UI directly."

```bash
builder discover   # finds running OpenCode sessions
```

**[SCREEN: output showing discovered agents]**

---

## Scene 4 — Live Dashboard Overview (120 sec)

**[SCREEN: Full dashboard — / route]**

Voiceover: "This is the operations view. Live telemetry streamed over SSE — no polling. You can see at a glance: incidents, GPU availability, newsbites site health, active agent sessions, and pipeline throughput."

**[CAMERA: Slow pan across panels, each one highlights briefly]**

- Incident timeline — red/amber/green severity badges
- GPU health — memory used, tunnel status
- NewsBites — article deploys, error rate
- Agent sessions — active vs idle
- Autopipeline — stage counts with per-vertical breakdown

---

## Scene 5 — Workflow Builder (150 sec)

**[SCREEN: Navigate to /opencode — agent sessions]**

Voiceover: "The Builder lets you define multi-pass AI workflows in YAML. Each pass runs an agent, produces artifacts, and is validated before the next pass starts."

**[SCREEN: Open an example workflow — hello-builder]**

```yaml
- id: plan
  name: "Plan"
  agent: opencode
  prompt: "Analyze the repository. Produce a PLAN.md."

- id: validate
  name: "Validate"
  agent: opencode
  prompt: "Check PLAN.md exists and is non-empty."
```

Voiceover: "This is a two-pass workflow: plan, then validate. You can also add a doctor-review pass that runs automatically if validation fails — diagnosing what went wrong and suggesting a fix."

**[SCREEN: Trigger a workflow run from the UI]**

Show the run log streaming in real time.

---

## Scene 6 — Model Routing (90 sec)

**[SCREEN: /models route — model cards with health indicators]**

Voiceover: "The Gateway handles model routing. You define a policy — which models to use for which tasks — and the system routes intelligently."

**[SCREEN: Show the fallback chain]**

- Primary: local GPU (gemma4:26b via Ollama)
- Cloud fallback: deepseek-v3, gemma4-31b, nemotron (via LiteLLM)

Voiceover: "When the GPU is busy or down, it bursts to cloud. When it comes back, traffic returns to local. You see the cost ledger per model and the health status of each endpoint."

---

## Scene 7 — Governance (90 sec)

**[SCREEN: Incident timeline — /incidents]**

Voiceover: "Every action is logged to an immutable audit chain. When something breaks, you see what happened, when, and what the impact was — without digging through log files."

**[SCREEN: Governance panel — policy list]**

Voiceover: "SSO via OIDC, data residency controls, configurable retention. Error responses are structured JSON — no stack traces in production."

---

## Scene 8 — Launch (30 sec)

**[SCREEN: control.techinsiderbytes.com — hero section]**

Voiceover: "The OpenCode Control Surface v1.0 is available today. Web UI, CLI, and REST API. Documentation, quickstart, and example workflows at control.techinsiderbytes.com."

**[END CARD: GitHub link, documentation link]**

---

## B-Roll Notes

- Use the live UTC clock and SSE "live" indicator as visual anchors throughout
- Show the tenant/project pill switcher in the header — demonstrates multi-tenancy
- For the GPU section: show the Vast tunnel status and memory gauge
- Keep terminal windows dark-themed to match the dashboard aesthetic