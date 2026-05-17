# Hello Builder Example

A minimal workflow that demonstrates the core Builder concepts: one pass, echo validation, artifact production.

## Files

```
hello-builder/
├── README.md          # This file
└── hello.yaml         # The workflow definition
```

## The Workflow

```yaml
version: "1.0"
name: "Hello Builder"
description: |
  Your first workflow. Run it in 5 minutes.
  This workflow writes a greeting to a file and validates it exists.
trigger:
  type: manual
agentOrder:
  - id: hello
    name: "Write Greeting"
    agent: opencode
    prompt: |
      Write a file called HELLO.txt in the current directory.
      Content:
      "Hello from Builder! This is my first workflow."
      "Timestamp: <current ISO timestamp>"
      
      Use the write tool to create the file.
    validationProfile:
      echo: "test -f HELLO.txt"
      timeoutMs: 10000
```

## Run It

```bash
# From the control surface project root
cd examples/hello-builder

# Run via CLI
builder run hello.yaml --tail

# Or copy to the project root and run from there
cp hello.yaml /opt/opencode-control-surface/PLAN.md
builder run /opt/opencode-control-surface/PLAN.md --tail
```

## Expected Output

```
[pass: hello] starting...
[pass: hello] validation passed
Workflow complete. 1/1 pass succeeded.
```

## What It Demonstrates

1. **Minimal workflow structure** — `version`, `name`, `agentOrder` are the only required fields
2. **Single pass with agent** — one `opencode` agent doing a defined task
3. **Echo validation** — `test -f HELLO.txt` confirms the file was created
4. **Artifact production** — `HELLO.txt` is stored as an artifact and viewable via the UI

## Next Steps

- Add a second pass: `review` that reads and validates the greeting content
- Schedule it: change `trigger.type` to `cron` with a schedule
- Expand: add `validationProfile` that checks the file has minimum length

## Files in This Example

- `hello.yaml` — the workflow definition
- `README.md` — this file