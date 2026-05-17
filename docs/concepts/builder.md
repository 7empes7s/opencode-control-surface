# Builder Pillar

**Version**: 1.0.0

---

## What is Builder?

Builder is the orchestration layer of the control surface. It lets you define multi-pass workflows using YAML, run them on a schedule or on-demand, and get structured results with full audit traceability.

Think of it as a programmable CI/CD system — but for AI-powered development tasks, not just code builds.

---

## Core Concepts

### Passes

A **pass** is a single unit of work in a workflow. Each pass:
- Has an `id` (unique identifier)
- Runs an `agent` (opencode, codex, or claude) with a `prompt`
- Produces **artifacts** (files, logs, structured data)
- Is validated by a `validationProfile` before the next pass starts

Example:
```yaml
- id: plan
  name: "Create Plan"
  agent: opencode
  prompt: "Analyze the repository and produce a PLAN.md file."
  validationProfile:
    echo: "test -f PLAN.md"
    timeoutMs: 15000
```

### Plan Files

Builder works from a **plan file** (`PLAN.md`) in the project root. Each pass:
1. Reads the plan file to understand the task
2. Makes changes to the codebase
3. Writes progress back to the plan (continuation)
4. Validates the output

The plan file format is:
```
## Task
<description of what to do>

## Progress
- [x] Completed step
- [ ] Next step
- ...

## Notes
<any contextual notes the next pass should know>
```

### Agent Order

The `agentOrder` list defines the sequence of passes. Each pass sees the full history of previous pass artifacts via the plan file or direct artifact access.

For conditional branching, use the `continueOnError` flag and the reasoner playbooks.

### Continuation

When a workflow runs again (manual or scheduled), Builder reads the current state of the plan file and continues from where the previous run left off. This means you can pause a long task, review it in the morning, and have it resume automatically.

To force a clean start: delete the plan file or use `builder run --reset`.

---

## Doctor Mode

Builder includes a built-in `doctor-review` mode. After any pass, you can trigger a diagnostic review:

```bash
builder workflow doctor-review <workflow-id>
```

The doctor agent reviews the current state, checks for:
- Resource exhaustion (disk, memory, GPU)
- Recent error patterns in logs
- Configuration drift from known-good state
- Security anomalies

Results are written as a structured artifact under `doctor-reports/`.

---

## Workflow Trigger Types

| Type | Description |
|---|---|
| `manual` | Run on-demand via CLI or UI |
| `cron` | Run on a schedule (crontab syntax) |
| `event` | Run when a specific event occurs (e.g., GitHub push) |

---

## Validation

The `validationProfile.echo` field runs a shell command after each pass. If the command exits 0, the pass is marked successful and the next pass begins. If it exits non-zero, the workflow stops (unless `continueOnError: true`).

Common patterns:
```yaml
# File exists
validationProfile:
  echo: "test -f OUTPUT.md"

# Tests pass
validationProfile:
  echo: "bun run test"
  timeoutMs: 60000

# Typecheck passes
validationProfile:
  echo: "bun run typecheck"
  timeoutMs: 30000
```

---

## Artifacts

Each pass produces artifacts stored under:
```
/var/lib/builder/artifacts/<workflow-id>/<run-id>/<pass-id>/
```

Available via:
- CLI: `builder artifacts cat <path>`
- API: `GET /api/builder/artifacts?path=<path>`
- UI: Builder → Runs → select run → Artifacts tab

---

## Model Routing

Builder uses the Gateway for model selection. Each pass can optionally specify a `model` override. If not specified, Builder uses the default model for the agent type.

The model policy (allowed/denied/fallback chain) is enforced at the Gateway level — Builder does not bypass model routing rules.

---

## RBAC and Approvals

High-risk workflows can be configured to require approval before execution:

```yaml
riskPolicy:
  requireApprovalFor: ["deploy-production", "delete-resource"]
  approvalThreshold: "one"
```

Approvals are tracked in the governance layer and visible in the audit chain.

---

## See Also

- [Quickstart](../quickstart.md) — run your first workflow in 5 minutes
- [Workflow Definition Schema](../workflow-definition.md) — full YAML schema reference
- [Gateway Pillar](../concepts/gateway.md) — model routing and health