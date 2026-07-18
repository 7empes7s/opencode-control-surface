#!/usr/bin/env bash
# Fresh-host durable gate (ULTRAPLAN P0.4).
#
# The ONE command that gates any "sellable" claim: boots the fresh-host
# container and runs the API probe (run.sh, kept alive), then runs the UI
# audit (the `fresh-host-ui` Playwright project) against that same running
# container, then tears the container down. Appends a "## UI audit" section
# to e2e/fresh-host/REPORT.md (route -> verdict table + failure detail).
#
# Exits non-zero if:
#   - REPORT.json shows any CRASH or ERROR-5xx verdict for any route, or
#   - REPORT.json shows any LEAK verdict for any route, or
#   - the fresh-host-ui Playwright project reports any failing spec.
#
# The one previously-documented KNOWN/ACCEPTED finding (fake-green "0 success"
# pill on /today, app/components/WorkloadGraphTable.tsx) was fixed by SPEC 5 —
# the success pill now renders gray when success+failed+running are all 0 —
# so this gate no longer carries a known-exception allowlist. Any failing spec
# is now a real gate failure.
#
# Hard rails: never touches the live :3000 service, never runs systemctl,
# never commits/pushes. Container is capped (via run.sh) + named cs-freshhost
# + always removed by this script on exit, success or failure.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRESH_HOST_DIR="$REPO/e2e/fresh-host"
REPORT_MD="$FRESH_HOST_DIR/REPORT.md"
REPORT_JSON="$FRESH_HOST_DIR/REPORT.json"
CONTAINER="cs-freshhost"
HOST_PORT="${FRESH_HOST_PORT:-4600}"
TOKEN="fresh-smoke-token"
WORKDIR="${FRESH_HOST_WORKDIR:-/tmp/cs-freshhost-work}"
UI_JSON="$WORKDIR/fresh-host-ui-report.json"
UI_STDERR="$WORKDIR/fresh-host-ui.stderr.log"

mkdir -p "$WORKDIR"

GATE_FAIL=0

teardown() {
  echo "[gate.sh] removing $CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap teardown EXIT

echo "[gate.sh] === stage 1: API probe (run.sh, FRESH_HOST_KEEP=1) ==="
FRESH_HOST_KEEP=1 FRESH_HOST_PORT="$HOST_PORT" "$FRESH_HOST_DIR/run.sh"
PROBE_EXIT=$?
echo "[gate.sh] run.sh exited $PROBE_EXIT"

if [ ! -f "$REPORT_JSON" ]; then
  echo "[gate.sh] FAIL: $REPORT_JSON missing -- probe did not complete"
  GATE_FAIL=1
  CRASH_COUNT="?"
  ERR5XX_COUNT="?"
  LEAK_COUNT="?"
  LEAKS=""
else
  CRASH_COUNT=$(jq -r '.counts.CRASH // 0' "$REPORT_JSON")
  ERR5XX_COUNT=$(jq -r '.counts["ERROR-5xx"] // 0' "$REPORT_JSON")
  LEAK_COUNT=$(jq -r '.counts.LEAK // 0' "$REPORT_JSON")

  if [ "$CRASH_COUNT" != "0" ]; then
    echo "[gate.sh] FAIL: $CRASH_COUNT CRASH verdict(s) in REPORT.json"
    GATE_FAIL=1
  fi
  if [ "$ERR5XX_COUNT" != "0" ]; then
    echo "[gate.sh] FAIL: $ERR5XX_COUNT ERROR-5xx verdict(s) in REPORT.json"
    GATE_FAIL=1
  fi

  LEAKS=$(jq -r '
    .results[]
    | select(.verdict == "LEAK")
    | "\(.route)\t\(.detail)"
  ' "$REPORT_JSON")

  if [ "$LEAK_COUNT" != "0" ]; then
    echo "[gate.sh] FAIL: $LEAK_COUNT LEAK verdict(s) in REPORT.json:"
    echo "$LEAKS"
    GATE_FAIL=1
  fi
fi

CONTAINER_UP=0
if docker ps --filter "name=${CONTAINER}" --filter "status=running" --format '{{.Names}}' | grep -q "^${CONTAINER}\$"; then
  CONTAINER_UP=1
fi

UI_TOTAL=0
UI_PASS=0
UI_FAIL=0
UI_ROWS=""
UI_FAILURE_DETAIL=""

if [ "$CONTAINER_UP" != "1" ]; then
  echo "[gate.sh] FAIL: $CONTAINER is not running after run.sh -- skipping UI audit"
  GATE_FAIL=1
  UI_FAILURE_DETAIL="container not running after API probe stage -- UI audit skipped"
else
  echo "[gate.sh] === stage 2: UI audit (fresh-host-ui Playwright project) ==="
  ( cd "$REPO" && FRESH_HOST_UI=1 FRESH_HOST_URL="http://localhost:${HOST_PORT}" OPERATOR_TOKEN="$TOKEN" \
      bunx playwright test --project=fresh-host-ui --reporter=json > "$UI_JSON" 2> "$UI_STDERR" )
  UI_EXIT=$?
  echo "[gate.sh] playwright fresh-host-ui exited $UI_EXIT"

  if [ ! -s "$UI_JSON" ]; then
    echo "[gate.sh] FAIL: no JSON output from playwright fresh-host-ui run (see $UI_STDERR)"
    GATE_FAIL=1
    UI_FAILURE_DETAIL="playwright produced no JSON report -- stderr tail:\n$(tail -n 40 "$UI_STDERR" 2>/dev/null)"
  else
    # Flatten every spec (regardless of suite nesting depth) to "title\tok".
    SPEC_ROWS=$(jq -r '[.. | objects | select(has("specs")) | .specs[]?] | .[] | "\(.title)\t\(.ok)"' "$UI_JSON" 2>/dev/null)
    UI_TOTAL=$(printf '%s\n' "$SPEC_ROWS" | grep -c $'\t' || true)
    UI_PASS=$(printf '%s\n' "$SPEC_ROWS" | awk -F'\t' '$2=="true"' | wc -l | tr -d ' ')
    UI_FAIL=$(printf '%s\n' "$SPEC_ROWS" | awk -F'\t' '$2=="false"' | wc -l | tr -d ' ')

    # One compact JSON object per failing spec -- every failure is now a real
    # gate failure (no known-exception allowlist; see header note).
    FAILING_SPECS=$(jq -c '[.. | objects | select(has("specs")) | .specs[]?] | .[] | select(.ok == false)' "$UI_JSON" 2>/dev/null)

    UNEXPECTED_COUNT=0
    while IFS= read -r specjson; do
      [ -z "$specjson" ] && continue
      title=$(jq -r '.title' <<< "$specjson")
      UNEXPECTED_COUNT=$((UNEXPECTED_COUNT + 1))
      UI_FAILURE_DETAIL="${UI_FAILURE_DETAIL}### ${title}
$(jq -r '[.tests[]?.results[]?.error?.message // empty] | join("\n")' <<< "$specjson" 2>/dev/null)

"
    done <<< "$FAILING_SPECS"

    while IFS=$'\t' read -r title ok; do
      [ -z "$title" ] && continue
      route="${title#fresh-host ui }"
      verdict="PASS"
      [ "$ok" = "false" ] && verdict="FAIL"
      UI_ROWS="${UI_ROWS}| ${route} | ${verdict} |
"
    done <<< "$SPEC_ROWS"

    if [ "$UNEXPECTED_COUNT" != "0" ]; then
      GATE_FAIL=1
    fi
  fi
fi

{
  echo ""
  echo "## UI audit"
  echo ""
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "Project: fresh-host-ui (chromium desktop) against http://localhost:${HOST_PORT}"
  echo ""
  echo "Total routes: ${UI_TOTAL} | PASS: ${UI_PASS} | FAIL: ${UI_FAIL}"
  echo ""
  echo "| Route | Verdict |"
  echo "|---|---|"
  if [ -n "$UI_ROWS" ]; then
    printf '%s' "$UI_ROWS"
  else
    echo "| (none) | ${UI_FAILURE_DETAIL:-no UI audit run} |"
  fi
  if [ -n "$UI_FAILURE_DETAIL" ]; then
    echo ""
    echo "### Failures"
    echo ""
    echo '```'
    printf '%s\n' "$UI_FAILURE_DETAIL"
    echo '```'
  fi
} >> "$REPORT_MD"

echo "[gate.sh] REPORT.md updated with ## UI audit section: $REPORT_MD"

echo "[gate.sh] === summary ==="
echo "[gate.sh] API probe: CRASH=${CRASH_COUNT} ERROR-5xx=${ERR5XX_COUNT} LEAK=${LEAK_COUNT}"
echo "[gate.sh] UI audit: total=${UI_TOTAL} pass=${UI_PASS} fail=${UI_FAIL} unexpected=${UNEXPECTED_COUNT:-0}"

if [ "$GATE_FAIL" != "0" ]; then
  echo "[gate.sh] GATE: FAIL"
  exit 1
fi

echo "[gate.sh] GATE: PASS"
exit 0
