# Quickstart

**Time**: ~5 minutes  
**Prerequisites**: Bun 1.x, access to the control surface instance

---

## Step 1 — Install the CLI

```bash
# Download the latest release (Linux x64)
curl -L https://control.techinsiderbytes.com/install.sh | bash

# Verify installation
builder --version
# → builder/1.0.0 linux-x64
```

Alternatively, use the web UI at `https://control.techinsiderbytes.com` — no CLI required.

---

## Step 2 — Configure Your Environment

```bash
export BUILDER_HOST="https://control.techinsiderbytes.com"
export BUILDER_TOKEN="your-operator-token"  # Find in the UI: Settings → API Tokens
```

Or create a `~/.builder/env` file:

```
BUILDER_HOST=https://control.techinsiderbytes.com
BUILDER_TOKEN=your-operator-token
```

---

## Step 3 — Create Your First Workflow

Create a file `hello-builder.yaml`:

```yaml
version: "1.0"
name: "Hello Builder"
description: "Your first workflow — echo validation"

trigger:
  type: manual

agentOrder:
  - id: hello
    name: "Say Hello"
    agent: opencode
    prompt: |
      Write a file called HELLO.txt containing:
      "Hello from Builder! Timestamp: <current ISO timestamp>"
    validationProfile:
      echo: "test -f HELLO.txt"
      timeoutMs: 10000
```

---

## Step 4 — Run It

```bash
builder run hello-builder.yaml
```

Expected output:
```
[pass: hello] starting...
[pass: hello] validation passed
Workflow complete. 1/1 pass succeeded.
```

---

## Step 5 — Read the Results

Artifacts from each pass are stored and accessible:

```bash
builder artifacts list
builder artifacts cat hello/latest/HELLO.txt
```

Or via the web UI → Builder → Runs → Select your run → Artifacts tab.

---

## Step 6 — Schedule It (Optional)

Update the workflow to run automatically:

```yaml
trigger:
  type: cron
  cron: "0 9 * * *"  # Every day at 9 AM UTC
```

Apply changes:

```bash
builder workflow update hello-builder.yaml
```

---

## Understanding the UI

| Section | What it does |
|---|---|
| **Builder** | Create, edit, and run workflows |
| **Gateway** | Monitor model health and routing |
| **Doctor** | Run diagnostics on all services |
| **Incidents** | View and resolve active issues |
| **Models** | See all available models and their status |

---

## Next Steps

- [Concepts: Builder](concepts/builder.md) — understand passes, plans, and continuation
- [Concepts: Gateway](concepts/gateway.md) — model routing, health probes, and cost ledger
- [Reference: API](reference/api.md) — full HTTP API reference
- [Examples](../examples/) — more workflow templates