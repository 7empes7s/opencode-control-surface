# First Builder Run — Hello Builder

**Estimated time**: 5 minutes  
**Goal**: Run your first builder workflow, inspect the output, and understand the basic cycle.

---

## Before you start

Make sure the control surface is running:
```bash
curl http://localhost:3000/health
```

You should see `{"ok":true}`. If not, restart it:
```bash
systemctl restart control-surface
```

---

## Step 1 — Create a project directory

```bash
mkdir -p ~/builder-projects/hello-demo
cd ~/builder-projects/hello-demo
```

This is where the builder will store workflow definitions, runs, and results.

---

## Step 2 — Define your first workflow

Create `workflow.yaml` in the project root:

```yaml
name: hello-demo
description: "Say hello and list the workspace root"

steps:
  - name: greet
    command: echo "Hello from the builder"
    validations:
      - kind: exit_code
        expect: 0
```

---

## Step 3 — Run it

```bash
cd ~/builder-projects/hello-demo
opencode builder run workflow.yaml
```

You should see output similar to:
```
RUN hello-demo-2025-05-17-001 STARTED
  step greet ............... pass ✓ (42ms)
RUN COMPLETED in 0.1s — 1 pass, 0 fail
```

---

## Step 4 — Inspect the results

After the run, a `.runs/` directory is created:
```bash
ls .runs/
cat .runs/latest/run.json | python3 -m json.tool
```

The `run.json` file contains:
- `id`, `startedAt`, `finishedAt`
- `steps[].name`, `steps[].status`, `steps[].durationMs`
- `validations[].kind`, `validations[].status`

---

## Step 5 — Add a second step with a validation failure

Update `workflow.yaml`:

```yaml
name: hello-demo
description: "Demo with a failing validation"

steps:
  - name: greet
    command: echo "Hello from the builder"
    validations:
      - kind: exit_code
        expect: 0

  - name: always-fail
    command: exit 1
    validations:
      - kind: exit_code
        expect: 0
```

Run it again:
```bash
opencode builder run workflow.yaml
```

Now you'll see:
```
  step always-fail .......... FAIL ✗ (12ms)
    validation exit_code: expected 0, got 1
```

---

## What you learned

- **Workflow files** are YAML with named steps and validations
- **Exit code validations** catch non-zero returns automatically
- **Results** are stored in `.runs/` and persist across restarts
- **The cycle**: write workflow → run → inspect results → iterate

---

## Next steps

- [02-scheduled-doctor](./02-scheduled-doctor.md) — set up a nightly health check on this project
- [03-policy-and-approval](./03-policy-and-approval.md) — add a human approval gate before critical steps