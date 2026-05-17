# CLI Reference

**Version**: 1.0.0

---

## Installation

```bash
curl -L https://control.techinsiderbytes.com/install.sh | bash
```

The installer:
1. Downloads the `builder` binary for your platform (`linux-x64`)
2. Places it in `$HOME/.builder/bin/` (or `/usr/local/bin/builder` if running as root)
3. Creates a shell completion script

### install.sh Flags

| Flag | Description |
|---|---|
| `--prefix DIR` | Install to custom directory (default: `$HOME/.builder`) |
| `--bin-dir DIR` | Place binary in DIR (default: `$PREFIX/bin`) |
| `--version VERSION` | Install specific version (default: latest) |
| `--help` | Show help |

### Verification

```bash
builder --version
# → builder/1.0.0 linux-x64
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BUILDER_HOST` | Yes | Control surface base URL (default: `https://control.techinsiderbytes.com`) |
| `BUILDER_TOKEN` | Yes | Operator token (from Settings → API Tokens) |
| `BUILDER_DB` | No | SQLite database path (default: `/var/lib/builder/builder.db`) |
| `BUILD_COMMIT` | No | Git commit hash for version info (auto-detected) |
| `BUILD_HASH` | No | Short hash override (auto-derived from BUILD_COMMIT) |
| `BUILD_TIME` | No | ISO timestamp override (auto-set to build time) |
| `BUILDER_NO_VERIFY_SSL` | No | Set to `1` to skip TLS certificate verification (dev only) |

Create `~/.builder/env`:
```
BUILDER_HOST=https://control.techinsiderbytes.com
BUILDER_TOKEN=your-token-here
```

---

## Commands

### builder --version
Print version info and exit.

```bash
builder --version
# builder/1.0.0 linux-x64
# build: abc123d (2026-05-17T12:00:00Z)
```

---

### builder run
Run a workflow from a YAML file.

```bash
builder run [workflow.yaml] [--reset] [--no-validation] [--tail]
```

| Flag | Description |
|---|---|
| `workflow.yaml` | Path to workflow YAML file (default: `./PLAN.md`) |
| `--reset` | Start from clean state (ignores previous progress) |
| `--no-validation` | Skip post-pass validation (runs all passes regardless) |
| `--tail` | Stream live pass output to stdout |

**Example**:
```bash
builder run my-workflow.yaml --tail
# [pass: plan] starting...
# [pass: plan] validation passed
# [pass: build] starting...
# Workflow complete. 2/2 passes succeeded.
```

---

### builder workflow
Manage workflows.

```bash
builder workflow list
builder workflow create <name> [--file workflow.yaml]
builder workflow update <name> [--file workflow.yaml]
builder workflow delete <name>
builder workflow show <name>
```

**Examples**:
```bash
builder workflow list
# ID   NAME                  TRIGGER   LAST RUN  STATUS
# abc  Nightly Doctor Review cron      2h ago    success
# def  Deploy Pipeline        manual    —         —

builder workflow show hello-builder
# name: Hello Builder
# trigger: manual
# agentOrder:
#   - id: hello
#     agent: opencode
# ...
```

---

### builder run
Manage workflow runs.

```bash
builder run list [--workflow <name>] [--status <status>]
builder run show <run-id>
builder run cancel <run-id>
builder run retry <run-id>
builder run logs <run-id> [--pass <pass-id>]
```

**Examples**:
```bash
builder run list --workflow "Nightly Doctor Review"
# RUN ID    WORKFLOW                STATUS   STARTED         FINISHED
# r01       Nightly Doctor Review   success  2026-05-17 02:00  2026-05-17 02:04
# r00       Nightly Doctor Review   failed   2026-05-16 02:00  2026-05-16 02:02

builder run logs r01 --pass build
# → streams log output for the 'build' pass
```

---

### builder artifacts
Manage workflow artifacts.

```bash
builder artifacts list [--workflow <name>] [--run <run-id>]
builder artifacts cat <path>
builder artifacts download <path> [--output DIR]
builder artifacts delete <path>
```

**Examples**:
```bash
builder artifacts list --workflow hello --run latest
# PATH                                           SIZE   MODIFIED
# hello/abc123/hello/HELLO.txt                   128 B  2026-05-17 10:00

builder artifacts cat hello/abc123/hello/HELLO.txt
# Hello from Builder! Timestamp: 2026-05-17T10:00:00Z
```

---

### builder logs
Stream or retrieve logs.

```bash
builder logs [--service <name>] [--since <duration>] [--grep <pattern>]
```

**Examples**:
```bash
builder logs --service newsbites --since 1h
# → last hour of newsbites service logs

builder logs --grep "ERROR" --since 30m
# → last 30 minutes of logs containing "ERROR"
```

---

### builder doctor
Run diagnostic checks.

```bash
builder doctor [--service <name>] [--fix]
```

| Flag | Description |
|---|---|
| `--service` | Run diagnostics for specific service only |
| `--fix` | Attempt automatic fixes where possible |

**Example**:
```bash
builder doctor --service newsbites
# [newsbites] CPU: 12%, Memory: 1.2GB — OK
# [newsbites] Disk: 45GB/100GB — WARNING (45% used)
# [newsbites] Recent errors: 0 — OK
# Diagnosis: disk usage approaching threshold. Recommendation: clean old logs.
```

---

### builder config
Manage configuration.

```bash
builder config get [--key <key>]
builder config set <key> <value>
builder config list
```

---

### builder completion
Generate shell completion scripts.

```bash
builder completion bash [--file /etc/bash_completion.d/builder]
builder completion zsh [--file ~/.zshrc.d/builder]
builder completion fish [--file ~/.config/fish/completions/builder.fish]
```

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Command succeeded |
| `1` | General error |
| `2` | Invalid arguments |
| `3` | Authentication failed |
| `4` | Resource not found |
| `5` | Workflow validation failed |
| `6` | Run failed (one or more passes failed) |
| `7` | Rate limited |
| `8` | Budget exceeded |

---

## Configuration File

`~/.builder/config.toml`:
```toml
[defaults]
host = "https://control.techinsiderbytes.com"
db_path = "/var/lib/builder/builder.db"

[auth]
token = "your-operator-token"

[risk]
allow_push = false
require_approval_for = ["deploy-*"]

[notifications]
webhook_url = "https://internal.example.com/alerts"
```

---

## Logging

`builder` logs to:
- stdout (when attached to a terminal)
- `/var/log/builder/builder.log` (system service)

Log level controlled by `BUILDER_LOG_LEVEL` env var (`debug`, `info`, `warn`, `error`).

---

## Debug Mode

```bash
BUILDER_LOG_LEVEL=debug builder run my-workflow.yaml --tail
```

Shows full request/response traces, model routing decisions, and timing breakdown.