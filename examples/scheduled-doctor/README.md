# Scheduled Doctor Example

A nightly workflow that runs health diagnostics on all services and reports findings.

## Files

```
scheduled-doctor/
├── README.md          # This file
└── doctor.yaml        # The workflow definition
```

## The Workflow

```yaml
version: "1.0"
name: "Nightly Doctor Review"
description: |
  Run health diagnostics every night at 2 AM UTC.
  Checks all services, GPU tunnel, model health, and disk usage.
  Reports critical issues as a structured artifact.
trigger:
  type: cron
  cron: "0 2 * * *"  # 2:00 AM UTC every day
  enabled: true
agentOrder:
  - id: discover
    name: "Discover Services"
    agent: opencode
    model: editorial-fast
    prompt: |
      Query all running services via systemctl.
      Output a JSON array of {name, status, memory, cpu} for each service.
      Services to check: newsbites, newsbites-autopipeline, litellm,
      opencode-server, control-surface, vast-tunnel, cloudflared,
      paperclip, openclaw_gateway, mimule-backup, model-health-check.
    validationProfile:
      echo: "test -f /tmp/services.json"

  - id: gpu-check
    name: "GPU Health"
    agent: opencode
    model: routing-cheap
    prompt: |
      Read /var/lib/mimule/gpu-health.json and report GPU status.
      Check: tunnel alive (curl localhost:11434), model loaded,
      recent errors, memory usage.
      Output: JSON {alive, modelLoaded, errorRate, memoryUsed}

  - id: model-health-check
    name: "Model Health"
    agent: opencode
    model: routing-cheap
    prompt: |
      Read /var/lib/mimule/model-health.json.
      Report: models available, latencyP50 for each, error rates.
      Flag any model with error_rate > 0.05.
      Output: JSON {models: [{name, status, latencyP50, errorRate}]}

  - id: disk-check
    name: "Disk Usage"
    agent: opencode
    prompt: |
      Run: df -h / /var /opt
      Report: each mount point's used%, available, flags if >85%.
      Output: JSON {mounts: [{path, usedPercent, available, alert}]}

  - id: compile-report
    name: "Compile Report"
    agent: opencode
    skillBundle: "health-report"
    prompt: |
      Compile all diagnostic results into a structured health report.
      
      Services from /tmp/services.json (or pass inline):
      GPU health from gpu-check:
      Model health from model-health-check:
      Disk usage from disk-check:
      
      Write the report to DIAGNOSTIC_REPORT.md in the artifact directory.
      
      Format:
      # Nightly Health Report — <date>
      
      ## Summary
      <one paragraph overview, color-coded: green if all OK, yellow if warnings, red if issues>
      
      ## Service Status
      | Service | Status | Memory | CPU |
      |---|---|---|---|
      | ... | ... | ... | ... |
      
      ## GPU Status
      <GPU status from gpu-check>
      
      ## Model Health
      <table of models with status indicators>
      
      ## Disk Usage
      <table of mount points, warnings highlighted>
      
      ## Recommended Actions
      <prioritized list of fixes, if any>
      
      If all checks pass, write: "All systems nominal. No action required."
      
    validationProfile:
      echo: "test -f DIAGNOSTIC_REPORT.md"
      timeoutMs: 30000

  - id: alert-if-needed
    name: "Alert on Issues"
    agent: opencode
    prompt: |
      Read DIAGNOSTIC_REPORT.md.
      If the Summary section contains "red" or "critical", send a webhook alert:
      POST to configured webhook URL with JSON body:
      { "alert": "health-report", "severity": "critical", "report": "<summary text>" }
      
      If all green or yellow only, do nothing (normal operation).
      
      Write the action taken to ALERT_STATUS.md (e.g., "alert sent" or "no alert needed").
    validationProfile:
      echo: "test -f ALERT_STATUS.md"
      timeoutMs: 15000

notification:
  channels: ["webhook"]
  webhookUrl: "https://internal.tib.com/alerts/doctor"
```

## Run It Manually

```bash
builder run doctor.yaml --tail
```

## View Reports

```bash
# List recent runs
builder run list --workflow "Nightly Doctor Review"

# View latest report
builder artifacts cat <run-id>/compile-report/DIAGNOSTIC_REPORT.md

# View alert status
builder artifacts cat <run-id>/alert-if-needed/ALERT_STATUS.md
```

## What It Demonstrates

1. **Cron trigger** — runs automatically every day at 2 AM UTC
2. **Multi-pass sequential** — 5 passes with data flow between them
3. **Conditional notification** — only alerts on critical issues
4. **Skill bundle usage** — uses `health-report` skill for report formatting
5. **Validation at each pass** — every pass validates its output before the next runs

## Configuration

Set your webhook URL in the workflow or via environment:
```bash
export ALERT_WEBHOOK_URL="https://your-alerting-system.com/webhook"
```