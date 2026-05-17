# Nightly Doctor Review

**Estimated time**: 10 minutes  
**Goal**: Configure a nightly automated health check that scans your project and reports issues every morning at 07:00 UTC.

---

## What is the doctor?

The `doctor` command performs a static analysis pass over your project:
- Checks that all referenced files exist
- Validates workflow YAML schema
- Reports orphaned run artifacts
- Flags workflows with no recent runs

---

## Step 1 — Create a nightly workflow

In your project directory, create `workflows/nightly-doctor.yaml`:

```yaml
name: nightly-doctor
description: "Nightly health check — runs automatically at 07:00 UTC"

trigger:
  schedule: "0 7 * * *"

steps:
  - name: run-doctor
    command: opencode builder doctor --project /opt/opencode-control-surface
    validations:
      - kind: exit_code
        expect: 0
```

---

## Step 2 — Register the scheduled workflow

```bash
opencode builder schedule set nightly-doctor \
  --cron "0 7 * * *" \
  --timezone UTC
```

Verify it was registered:
```bash
opencode builder schedule list
```

---

## Step 3 — Test the schedule manually

Run it immediately to confirm it works:
```bash
opencode builder run workflows/nightly-doctor.yaml
```

Check the output for any warnings or errors. Fix any issues before leaving it to run nightly.

---

## Step 4 — Inspect the last run

```bash
opencode builder run list --limit 5
```

Find the `nightly-doctor` run and inspect it:
```bash
opencode builder run show <run-id>
```

---

## How it works

- **cron expression** is parsed and stored in the operator state
- **trigger system** evaluates schedules every minute via a timer service
- **results** are stored in `.runs/nightly-doctor-<timestamp>/run.json`
- **failures** do NOT stop the schedule — the next run still fires

---

## Troubleshooting

**Schedule not firing?**
```bash
systemctl status opencode-scheduler
journalctl -u opencode-scheduler -n 20
```

**Doctor reports missing files?**
Check that your `--project` path matches the actual project root. Relative paths are resolved from the workflow file location.

---

## Next steps

- [03-policy-and-approval](./03-policy-and-approval.md) — add a human approval gate for production deployments