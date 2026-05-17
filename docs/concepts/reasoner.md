# Reasoner Pillar

**Version**: 1.0.0

---

## Overview

The Reasoner is the anomaly detection and auto-remediation engine. It watches the system, identifies problems, diagnoses root causes, and can apply fix playbooks automatically.

---

## Jobs

The Reasoner runs on a periodic schedule (every 3 minutes by default). Each cycle:

1. Collects signals from all services (status, logs, metrics)
2. Checks against known anomaly patterns
3. If found, creates a **diagnosis** and optionally an **incident**
4. If a matching **playbook** exists and `auto_remediate` is enabled, applies the fix

View current jobs:
```bash
curl https://control.techinsiderbytes.com/api/reasoner/jobs
```

---

## Diagnoses

A diagnosis is the Reasoner's analysis of a specific anomaly. It includes:
- **What** was detected (anomaly type, severity)
- **Where** it occurred (service, host, component)
- **Why** it happened (root cause hypothesis)
- **Recommended fix** (playbook name or manual steps)

View diagnoses:
```bash
curl https://control.techinsiderbytes.com/api/reasoner/diagnoses
curl https://control.techinsiderbytes.com/api/reasoner/diagnoses/<pass-id>
```

---

## Incidents

When a diagnosis exceeds the severity threshold, an **incident** is created. Incidents are tracked until resolved.

```bash
# List incidents
curl https://control.techinsiderbytes.com/api/reasoner/incidents

# Resolve manually
curl -X POST https://control.techinsiderbytes.com/api/reasoner/incidents/<id>/resolve
```

Incident states: `open` → `acknowledged` → `resolved`

---

## Playbooks

A playbook is an automated fix procedure. Playbooks are written in YAML and stored in the Reasoner's playbook registry.

```bash
# List playbooks
curl https://control.techinsiderbytes.com/api/reasoner/playbooks

# Apply a playbook manually
curl -X POST https://control.techinsiderbytes.com/api/reasoner/playbooks/<id>/apply
```

### Built-in Playbooks

| Playbook | Trigger | Action |
|---|---|---|
| `restart-failed-service` | Service exits unexpectedly | `systemctl restart <service>` |
| `clear-oom-killer` | OOM kill detected | Free memory, restart affected service |
| `restart-gpu-tunnel` | GPU unreachable | `systemctl restart vast-tunnel` |
| `scale-down-idle` | No traffic for 30min + high memory | Scale down replica count |
| `rotate-logenclave` | Log rotation failure | Force log rotation, restart logging daemon |

---

## Auto-Remediation

Enable auto-remediation per playbook:

```yaml
riskPolicy:
  auto remediate: true  # Warning: enables automatic changes to the system
```

With auto-remediation enabled, the Reasoner will apply the playbook without waiting for human confirmation. Use with caution — always monitor the incident feed when auto-remediation is active.

---

## Doctor Mode Integration

The Reasoner feeds into the Builder's `doctor-review` workflow. When a `doctor-review` is triggered on a workflow run, the Reasoner produces a structured diagnosis that is written as an artifact and can be reviewed in the UI.

---

## Signal Sources

The Reasoner aggregates signals from:
- `systemctl status` — service state
- `journalctl` — recent log entries
- `/var/lib/mimule/gpu-health.json` — GPU tunnel health
- `/var/lib/mimule/model-health.json` — model health
- `/var/lib/mimule/pipeline-state.json` — autopipeline state
- Custom webhook alerts (configured per tenant)

---

## Severity Levels

| Level | Description | Auto-remediate? |
|---|---|---|
| `info` | Informational, no action needed | No |
| `warning` | Potential issue, monitor | No |
| `error` | Service degraded, action needed | Optional |
| `critical` | Service down, immediate action required | Yes (if enabled) |

---

## See Also

- [API Reference](../reference/api.md) — reasoner endpoints
- [Operations: Troubleshooting](../operations/troubleshooting.md) — common failure modes
- [Builder Pillar](./builder.md) — doctor-review integration