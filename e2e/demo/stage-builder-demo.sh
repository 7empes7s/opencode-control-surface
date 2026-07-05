#!/usr/bin/env bash
# stage-builder-demo.sh — SPEC 7 (ULTRAPLAN P1.1 / SHOWCASE Phase 3)
#
# One-command stage/fix/reset for the Builder showcase demo: a tiny real Bun +
# TypeScript app (e2e/demo/builder-demo-template/) copied to a real git repo
# at /opt/provisioned/builder-showcase-demo, with a real, planted logic bug as
# a second commit — then registered as a Builder project + a `once`-mode
# workflow on the LIVE Control Surface service via its own HTTP API (the same
# API a real operator uses), so starting it drives the real
# pass -> validation -> (failure|success) pipeline against a real repo.
#
# Usage:
#   e2e/demo/stage-builder-demo.sh            # stage (idempotent): copy template,
#                                              #   green commit, bug commit, register
#   e2e/demo/stage-builder-demo.sh --fix       # deterministic fix: known-good
#                                              #   discount.ts as a real git commit
#   e2e/demo/stage-builder-demo.sh --reset     # back to the staged bug state +
#                                              #   clear this demo's workflow runs
#
# Hard rails (see e2e/demo/BUILDER_DEMO.md for the full writeup):
#   - Only ever writes inside /opt/provisioned/builder-showcase-demo (git repo)
#     and talks to the live service over its own HTTP API (no direct sqlite
#     writes, no systemctl, no pkill).
#   - Never widens any allowlist — registration goes through the existing
#     provision + workflow-create endpoints, exactly as a human operator would.
#   - --reset only ever deletes/stops the ONE workflow this script itself
#     registered (looked up by exact name + project root) — never a broad
#     DELETE across all workflows/runs.
#   - The operator token is read from /etc/control-surface/secrets.env and is
#     never echoed or logged.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE_DIR="$REPO/e2e/demo/builder-demo-template"
DEMO_ROOT="/opt/provisioned/builder-showcase-demo"
CS_BASE_URL="${CS_BASE_URL:-http://127.0.0.1:3000}"
SECRETS_FILE="${CS_SECRETS_FILE:-/etc/control-surface/secrets.env}"
PROJECT_NAME="Showcase Builder Demo (staged)"
WORKFLOW_NAME="Showcase Builder Demo — staged bug pass (once)"
BUG_TAG="demo-bug-state"
BUG_MARKER="100 + discountPercent"
GOOD_MARKER="100 - discountPercent"

ACTION="${1:-stage}"


# log() writes to STDERR deliberately: several functions below (register_workflow,
# find_workflow_id, project_registered) are invoked via `x="$(fn)"` command
# substitution, which captures STDOUT as the "return value" — progress logs must
# never leak into that captured value.
log()  { echo "[stage-builder-demo] $*" >&2; }
fail() { echo "[stage-builder-demo] ERROR: $*" >&2; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }
require_cmd git
require_cmd curl
require_cmd jq

token() {
  [ -f "$SECRETS_FILE" ] || fail "secrets file not found: $SECRETS_FILE"
  local t
  t="$(grep -E '^OPERATOR_TOKEN=' "$SECRETS_FILE" | cut -d= -f2-)"
  [ -n "$t" ] || fail "OPERATOR_TOKEN not found in $SECRETS_FILE"
  printf '%s' "$t"
}
TOKEN="$(token)"

# ── HTTP helpers (operator-token header auth — server/auth/session.ts) ─────
cs_get() {
  curl -sS -H "x-operator-token: $TOKEN" "$CS_BASE_URL$1"
}
cs_post() {
  # NOTE: intentionally not `body="${2:-{}}"` — bash's brace-matching for a
  # `${var:-default}` expansion gets confused by literal `{}` in the default
  # and silently appends a stray `}` to a *provided* $2, corrupting the JSON.
  local path="$1"
  local body="$2"
  [ -z "$body" ] && body="{}"
  curl -sS -X POST -H "x-operator-token: $TOKEN" -H "Content-Type: application/json" -d "$body" "$CS_BASE_URL$path"
}
cs_put() {
  local path="$1" body="$2"
  curl -sS -X PUT -H "x-operator-token: $TOKEN" -H "Content-Type: application/json" -d "$body" "$CS_BASE_URL$path"
}
cs_delete() {
  curl -sS -X DELETE -H "x-operator-token: $TOKEN" -o /dev/null -w '%{http_code}' "$CS_BASE_URL$1"
}

# ── Git repo staging (green baseline -> planted bug, real commits) ─────────
git_repo() { git -C "$DEMO_ROOT" "$@"; }

ensure_repo_copied() {
  if [ ! -d "$DEMO_ROOT" ]; then
    log "creating $DEMO_ROOT from template"
    mkdir -p "$(dirname "$DEMO_ROOT")"
    cp -r "$TEMPLATE_DIR" "$DEMO_ROOT"
  fi
  [ -d "$DEMO_ROOT/.git" ] || git_repo init -q
  git_repo config user.email >/dev/null 2>&1 || git_repo config user.email "builder-demo@localhost"
  git_repo config user.name  >/dev/null 2>&1 || git_repo config user.name  "Builder Demo Stager"
}

# Ensures history is: (1) green baseline commit, (2) bug-planted commit tagged
# $BUG_TAG. Idempotent: if the repo has no commits yet, creates both. If the
# repo already has history (e.g. a prior --fix commit sits on top), resets
# hard to the tagged bug commit instead of layering a redundant bug commit.
ensure_bug_state() {
  if ! git_repo rev-parse --verify -q HEAD >/dev/null 2>&1; then
    git_repo add -A
    git_repo commit -q -m "Initial (green) state: checkout calculator passes bun test"
    log "committed green baseline: $(git_repo rev-parse --short HEAD)"

    sed -i "s/${GOOD_MARKER}/${BUG_MARKER}/" "$DEMO_ROOT/src/discount.ts"
    grep -q "$BUG_MARKER" "$DEMO_ROOT/src/discount.ts" || fail "failed to plant the bug marker in src/discount.ts"
    git_repo add -A
    git_repo commit -q -m "Plant known bug (demo): discount applies +N% instead of -N%

This is the staged, presenter-visible bug for the Builder showcase scenario.
See src/discount.ts — the sign in applyDiscount() is flipped, so a discount
INCREASES the price instead of reducing it. bun test now fails."
    git_repo tag -f "$BUG_TAG" HEAD >/dev/null
    log "planted bug and tagged $BUG_TAG: $(git_repo rev-parse --short HEAD)"
    return
  fi

  if git_repo rev-parse --verify -q "refs/tags/$BUG_TAG" >/dev/null 2>&1; then
    if [ "$(git_repo rev-parse HEAD)" != "$(git_repo rev-parse "$BUG_TAG")" ] || [ -n "$(git_repo status --porcelain)" ]; then
      log "repo already staged once — resetting working tree to $BUG_TAG"
      git_repo reset -q --hard "$BUG_TAG"
      git_repo clean -q -fd
    else
      log "repo already at the staged bug state ($BUG_TAG) — nothing to do"
    fi
  else
    fail "repo has commits but no $BUG_TAG tag — refusing to guess; inspect $DEMO_ROOT manually"
  fi
}

# ── Builder registration (existing provision + workflow-create mechanisms) ─

find_workflow_id() {
  cs_get "/api/builder/workflows" \
    | jq -r --arg name "$WORKFLOW_NAME" --arg root "$DEMO_ROOT" \
      '.data.workflows[]? | select(.name == $name and .projectRoot == $root) | .id' \
    | head -n1
}

project_registered() {
  cs_get "/api/builder/projects" | jq -e --arg root "$DEMO_ROOT" '.data.projects[]? | select(.root == $root)' >/dev/null 2>&1
}

register_project() {
  if project_registered; then
    log "project already registered at $DEMO_ROOT"
    return
  fi
  log "provisioning project via POST /api/builder/provision"
  local resp
  resp="$(cs_post "/api/builder/provision" "$(jq -n \
    --arg root "$DEMO_ROOT" \
    --arg name "$PROJECT_NAME" \
    --arg desc "Staged Builder showcase scenario (ULTRAPLAN P1.1 / SHOWCASE Phase 3): a tiny real Bun+TS checkout calculator with a planted, real bun-test-failing bug." \
    --arg plan "$DEMO_ROOT/PLAN.md" \
    '{projectRoot:$root,name:$name,description:$desc,planFile:$plan,validationCommands:["bun test"],gitPolicy:{commit:"manual",push:"never"}}')")"
  echo "$resp" | jq -e '.data.result.error == null' >/dev/null 2>&1 \
    || fail "provision failed: $(echo "$resp" | jq -r '.data.result.error // .error // .')"
  log "provisioned: $(echo "$resp" | jq -r '.data.result.workflowId')  (auto-continue draft — unused; see registered once-mode workflow below)"
}

register_workflow() {
  local existing
  existing="$(find_workflow_id)"
  if [ -n "$existing" ]; then
    log "workflow already registered: $existing"
    printf '%s' "$existing"
    return
  fi
  log "creating once-mode workflow via POST /api/builder/workflows"
  # agentOrder uses the "group:agentic-heavy" token (server/builder/store.ts
  # expandAgentOrderGroups) rather than a hardcoded model id — it dynamically
  # resolves to the CURRENTLY verified free-model roster from
  # /var/lib/control-surface/agentic-models.json at workflow-save time.
  # passTimeoutSeconds/stallTimeoutSeconds are tightened from the system
  # default (1500s/2700s) to 240s: observed live during this task, 2 of the
  # 3 group models (opencode/deepseek-v4-flash-free,
  # opencode/nemotron-3-ultra-free) not-infrequently stall or take >20 minutes
  # on this trivial repo, so the default timeout would make a "start the
  # workflow" demo click take up to 75 minutes worst case (3 sequential
  # passes). 240s keeps a full worst-case run (2 timeouts + 1 quick success)
  # under ~9 minutes while still giving each model a genuine chance to finish
  # (the model that succeeded live did so in under 2 minutes).
  local resp id
  resp="$(cs_post "/api/builder/workflows" "$(jq -n \
    --arg name "$WORKFLOW_NAME" \
    --arg root "$DEMO_ROOT" \
    --arg plan "$DEMO_ROOT/PLAN.md" \
    '{
      name: $name,
      projectRoot: $root,
      planFile: $plan,
      mode: "once",
      status: "ready",
      config: {
        projectRoot: $root,
        agentOrder: ["opencode:group:agentic-heavy"],
        modelPolicy: { fallbackTargets: [] },
        validationProfile: { commands: ["bun test"], internal: ["bun test"], runtime: [], public: [] },
        gitPolicy: { commit: "manual", push: "never" },
        backupPolicy: { enabled: false, beforeRun: false },
        riskPolicy: {
          liveDeploys: "disabled",
          maxPasses: 1,
          passTimeoutSeconds: 240,
          stallTimeoutSeconds: 240
        }
      }
    }')")"
  id="$(echo "$resp" | jq -r '.data.workflow.id // empty')"
  [ -n "$id" ] || fail "workflow create failed: $(echo "$resp" | jq -r '.error // .')"
  log "registered workflow: $id"
  printf '%s' "$id"
}

print_next_steps() {
  local id="$1"
  cat <<EOF

[stage-builder-demo] Ready.
  Project:  $PROJECT_NAME
  Root:     $DEMO_ROOT
  Workflow: $WORKFLOW_NAME
  Workflow id: $id

Next click (presenter):
  1. Open https://control.techinsiderbytes.com/builder (or /agent-team)
  2. Find "$PROJECT_NAME" -> "$WORKFLOW_NAME"
  3. Click Start. Expect: pass runs, then a "bun test" validation FAILS
     (the planted bug). See e2e/demo/BUILDER_DEMO.md for the full script.

Or via API:
  TOKEN=\$(grep -E '^OPERATOR_TOKEN=' /etc/control-surface/secrets.env | cut -d= -f2-)
  curl -s -X POST -H "x-operator-token: \$TOKEN" $CS_BASE_URL/api/builder/workflows/$id/start
EOF
}

do_stage() {
  ensure_repo_copied
  ensure_bug_state
  register_project
  local id
  id="$(register_workflow)"
  [[ "$id" == bw_* ]] || fail "register_workflow did not return a workflow id (got: '$id')"
  print_next_steps "$id"
}

do_fix() {
  [ -d "$DEMO_ROOT/.git" ] || fail "$DEMO_ROOT is not staged yet — run without flags first"
  if grep -q "$GOOD_MARKER" "$DEMO_ROOT/src/discount.ts" 2>/dev/null && ! grep -q "$BUG_MARKER" "$DEMO_ROOT/src/discount.ts" 2>/dev/null; then
    log "already fixed — nothing to do"
    return
  fi
  # Deterministic fix: copy back the known-good template source, verbatim,
  # rather than trying to patch whatever state an agentic pass may have left
  # the file in. This is "the fix beat when no capable model is available
  # live" per the task spec — a real, presenter-visible git commit either way.
  cp "$TEMPLATE_DIR/src/discount.ts" "$DEMO_ROOT/src/discount.ts"
  if [ -z "$(git_repo status --porcelain)" ]; then
    log "working tree already matches the known-good fix — nothing to commit"
    return
  fi
  git_repo add -A
  git_repo commit -q -m "Fix: revert discount sign flip (deterministic demo fix)

Restores src/discount.ts to the known-good template version. Applied by
stage-builder-demo.sh --fix rather than an agentic pass — see
e2e/demo/BUILDER_DEMO.md for which path this demo run actually took."
  log "committed deterministic fix: $(git_repo rev-parse --short HEAD)"
}

do_reset() {
  [ -d "$DEMO_ROOT/.git" ] || fail "$DEMO_ROOT is not staged yet — nothing to reset"

  local id
  id="$(find_workflow_id)"
  if [ -n "$id" ]; then
    local status
    status="$(cs_get "/api/builder/workflows/$id" | jq -r '.data.workflow.status // empty')"
    if [ "$status" = "running" ]; then
      log "stopping running workflow $id before clearing runs"
      cs_post "/api/builder/workflows/$id/stop" '{"reason":"stage-builder-demo.sh --reset"}' >/dev/null
    fi
    log "clearing this demo's workflow ($id) via DELETE /api/builder/workflows/$id (scoped to this id only)"
    local http_code
    http_code="$(cs_delete "/api/builder/workflows/$id")"
    [ "$http_code" = "204" ] || log "warning: delete returned HTTP $http_code (continuing)"
  else
    log "no registered workflow found to clear (nothing to stop/delete)"
  fi

  ensure_repo_copied
  ensure_bug_state

  # Re-create the once-mode workflow so the demo is immediately re-clickable
  # (the project registration itself is untouched/idempotent — only the
  # workflow + its run history were cleared above).
  local new_id
  new_id="$(register_workflow)"
  [[ "$new_id" == bw_* ]] || fail "register_workflow did not return a workflow id (got: '$new_id')"
  print_next_steps "$new_id"
}

case "$ACTION" in
  stage|"") do_stage ;;
  --fix)    do_fix ;;
  --reset)  do_reset ;;
  *) fail "unknown action: $ACTION (expected: stage (default), --fix, --reset)" ;;
esac
