# Workflow Definition Schema

**Version**: 1.0.0  
**Status**: Frozen  

A Builder workflow is defined by a single YAML or JSON file. This document describes the frozen schema (`workflowDefinition.v1`).

---

## Top-Level Structure

```yaml
version: "1.0"          # Required. Must be "1.0". Specifies schema version.
name: string            # Required. Human-readable workflow name.
description?: string    # Optional. One-paragraph description.
owner?: string          # Optional. Team or individual responsible.

agentOrder:             # Required. Ordered list of agents (passes).
  - id: string            # Unique pass identifier (e.g., "plan", "build", "review")
    name: string          # Human-readable pass name
    agent: string         # Agent type: "opencode" | "codex" | "claude"
    model?: string         # Optional model override (e.g., "editorial-heavy")
    maxRetries?: number    # Optional. Default: 1.
    continueOnError?: bool # Optional. Default: false.
    skillBundle?: string   # Optional. Skill bundle name to load for this pass.
    prompt: string |Ref    # Pass instruction (inline string or $ref to external file)
    validationProfile?: ValidationProfile  # Optional. See below.
    modelPolicy?: ModelPolicy              # Optional. See below.
    riskPolicy?: RiskPolicy                # Optional. See below.
    gitPolicy?: GitPolicy                  # Optional. See below.
    backupPolicy?: BackupPolicy            # Optional. See below.

trigger:                 # Optional. How the workflow is started.
  type: "manual" | "cron" | "event"
  cron?: string          # crontab expression (e.g., "0 2 * * *" for 2 AM daily)
  event?: string         # Event name that triggers this workflow
  enabled?: bool         # Default: true

notification?:          # Optional. Where to send run results.
  channels: ("email" | "slack" | "webhook")[]
  webhookUrl?: string
  email?: string
```

---

## ValidationProfile

Applied after each pass to determine whether to continue.

```yaml
validationProfile:
  echo: string           # Command to run. Exit 0 = pass. Exit non-zero = fail.
  timeoutMs?: number     # Max time for echo command. Default: 30000.
  continueOnFailure?: bool # If true, failed validation does NOT stop workflow. Default: false.
```

**Example**:
```yaml
validationProfile:
  echo: "bun run check"
  timeoutMs: 60000
```

---

## ModelPolicy

Controls which models can be used within a pass.

```yaml
modelPolicy:
  allowed: string[]       # List of allowed model names (e.g., ["gemma4:26b", "qwen3:8b"])
  denied?: string[]       # List of denied model names (takes precedence over allowed)
  fallbackChain?: string[] # Ordered list of models to try if primary fails
  timeoutMs?: number       # Max time for a single model call. Default: 300000.
  costLimitMsat?: number   # Max spend in milli-satoshis (for metered contexts)
```

---

## RiskPolicy

Defines what operations require human approval or are blocked.

```yaml
riskPolicy:
  blockList?: string[]     # Operation names to block entirely
  requireApprovalFor?: string[] # Operations that require explicit approval before executing
  approvalThreshold?: "one" | "two"  # Required approvers. Default: "one".
  auto remediate?: bool   # If true, reasoner may auto-fix issues detected. Default: false.
```

---

## GitPolicy

Controls how the workflow interacts with git.

```yaml
gitPolicy:
  allowPush?: bool        # Default: false.
  allowForcePush?: bool  # Default: false.
  allowBranchDelete?: bool # Default: false.
  allowedBranches?: string[] # If set, only these branches can be modified
  commitMessageTemplate?: string # Template for auto-generated commits
  signCommits?: bool      # Default: false.
```

---

## BackupPolicy

Defines backup behavior for this workflow's artifacts.

```yaml
backupPolicy:
  enabled?: bool          # Default: true.
  schedule?: string       # Cron expression for automated backups. Default: "0 4 * * *".
  destination?: string    # Backup destination (e.g., "local", "s3://bucket/prefix"). Default: "local".
  retentionDays?: number  # Number of days to keep backups. Default: 30.
  excludePatterns?: string[] # Glob patterns for files to exclude from backup.
```

---

## Trigger Examples

### Manual (default)
```yaml
trigger:
  type: manual
```

### Nightly at 2 AM UTC
```yaml
trigger:
  type: cron
  cron: "0 2 * * *"
  enabled: true
```

### On event
```yaml
trigger:
  type: event
  event: "github.push"
```

---

## Full Example

```yaml
version: "1.0"
name: "Nightly Doctor Review"
description: "Run health diagnostics on all services every night and report findings."
owner: "platform@tib.com"

trigger:
  type: cron
  cron: "0 2 * * *"

agentOrder:
  - id: scout
    name: "Service Discovery"
    agent: opencode
    model: editorial-fast
    prompt: |
      Discover all running services on this host.
      Output a JSON list of service names and their statuses.

  - id: diagnose
    name: "Run Diagnostics"
    agent: opencode
    prompt: |
      For each service discovered in the previous pass:
      1. Run systemctl status for the service
      2. Check for recent error logs (journalctl -n 50 --no-pager)
      3. Report any anomalies in structured JSON format.

  - id: report
    name: "Generate Report"
    agent: opencode
    skillBundle: "health-report"
    prompt: |
      Compile the diagnostic results into a human-readable report.
      Format: markdown. Include: summary, issues found, recommended actions.

  - id: notify
    name: "Send Notification"
    agent: opencode
    prompt: |
      If any critical issues were found, send a webhook notification
      to the configured endpoint with the report payload.
      If no issues, skip notification.

notification:
  channels: ["webhook"]
  webhookUrl: "https://internal.tib.com/alerts/doctor"

agentOrder:
  - id: plan
    name: "Plan"
    agent: opencode
    prompt: "Analyze the codebase and produce a development plan."
    validationProfile:
      echo: "test -f PLAN.md"
      timeoutMs: 10000

  - id: build
    name: "Build"
    agent: opencode
    model: coding-heavy
    prompt: "Implement the changes described in PLAN.md"
    validationProfile:
      echo: "bun run check"
      timeoutMs: 120000
    modelPolicy:
      allowed: ["gemma4:26b", "qwen2.5-coder:14b"]
      fallbackChain: ["gemma4:26b", "qwen2.5-coder:14b"]

  - id: review
    name: "Review"
    agent: claude
    prompt: |
      Review the implementation in the current directory.
      Focus on: correctness, security, performance.
      Report findings as a structured JSON artifact.
    validationProfile:
      echo: "test -f review-output.json"
```

---

## Schema Versioning

This schema is versioned with the API. Workflow files should specify `version: "1.0"`. The schema may be extended with optional fields in future minor versions; the `version` field must always be present.