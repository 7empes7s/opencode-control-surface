#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
TOKEN="${OPERATOR_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "OPERATOR_TOKEN is required" >&2
  exit 2
fi

failures=0

record_failure() {
  failures=$((failures + 1))
}

curl_capture() {
  local url="$1"
  local header="${2:-}"
  local tmp status size

  tmp="$(mktemp)"
  if [[ -n "$header" ]]; then
    status="$(curl -sS -L --max-time 12 -o "$tmp" -w '%{http_code}' -H "$header" "$url" || true)"
  else
    status="$(curl -sS -L --max-time 12 -o "$tmp" -w '%{http_code}' "$url" || true)"
  fi
  size="$(wc -c < "$tmp" | tr -d ' ')"
  printf '%s\t%s\t%s\n' "$status" "$size" "$tmp"
}

check_spa_route() {
  local path="$1"
  local url="${BASE_URL%/}$path"
  local status size tmp

  IFS=$'\t' read -r status size tmp < <(curl_capture "$url")
  if [[ "$status" != "200" ]]; then
    echo "FAIL route $path -> HTTP $status (${size} bytes)" >&2
    sed -n '1,6p' "$tmp" >&2
    rm -f "$tmp"
    record_failure
    return
  fi
  if ! grep -qiE '<!doctype html|<html|id="root"' "$tmp"; then
    echo "FAIL route $path -> missing app shell (${size} bytes)" >&2
    sed -n '1,6p' "$tmp" >&2
    rm -f "$tmp"
    record_failure
    return
  fi
  rm -f "$tmp"
  printf 'OK   route %-24s HTTP %s %s bytes\n' "$path" "$status" "$size"
}

check_json_api() {
  local label="$1"
  local path="$2"
  local header="${3:-}"
  local url="${BASE_URL%/}$path"
  local status size tmp

  IFS=$'\t' read -r status size tmp < <(curl_capture "$url" "$header")
  if [[ "$status" != "200" ]]; then
    echo "FAIL $label $path -> HTTP $status (${size} bytes)" >&2
    sed -n '1,12p' "$tmp" >&2
    rm -f "$tmp"
    record_failure
    return
  fi
  if ! bun -e 'JSON.parse(await Bun.stdin.text())' < "$tmp" >/dev/null 2>&1; then
    echo "FAIL $label $path -> response is not valid JSON (${size} bytes)" >&2
    sed -n '1,12p' "$tmp" >&2
    rm -f "$tmp"
    record_failure
    return
  fi
  rm -f "$tmp"
  printf 'OK   %-9s %-24s HTTP %s %s bytes\n' "$label" "$path" "$status" "$size"
}

SPA_ROUTES="${SPA_ROUTES:-/,/status,/insights,/security,/agents,/today,/autopipeline,/agent-team,/doctor,/models,/newsbites,/infra,/incidents,/jobs,/audit,/builder,/brainstorm,/settings,/opencode,/codex,/claude,/gemini,/workflows,/marketplace,/traces,/gateway,/governance,/compliance,/projects,/about,/install,/finance-intel,/litellm,/scout,/channels,/content-health,/reports}"
PUBLIC_APIS="${PUBLIC_APIS:-/health,/api/public-status,/api/version,/api/home,/api/product-health,/api/metrics/showcase,/api/events,/api/metrics,/api/autopipeline,/api/doctor,/api/models,/api/agent-team,/api/newsbites,/api/infra,/api/incidents,/api/agents/skills,/api/agents/summary,/api/agents/workspaces,/api/traces,/api/litellm/status,/api/litellm/routing,/api/litellm/config,/api/scout/runs,/api/scout/config,/api/finance-intel/stats,/api/finance-intel/runs,/api/finance-intel/enrichments,/api/finance-intel/portfolio-configs,/api/paperclip/agents,/api/paperclip/tasks,/api/gateway/status,/api/gateway/models,/api/gateway/ledger,/api/gateway/stats,/api/cost,/v1/models,/api/mission-control,/api/today,/api/workload,/api/settings/auth-status,/api/governance/audit,/api/sso/session,/api/marketplace/skills,/api/reports,/api/reports/templates,/api/tenant/settings,/api/licensing/status,/api/telemetry/preview,/api/onboarding/status,/api/docs/tutorials,/api/cloud-tier/status,/api/cost/summary,/api/compliance/dpa,/api/compliance/subprocessors,/api/compliance/soc2-mapping,/api/compliance/summary,/api/compliance/evidence-bundle}"
PROTECTED_APIS="${PROTECTED_APIS:-/api/auth/status,/api/actions/catalog,/api/content-health/findings,/api/insights,/api/security/posture,/api/security/trust-score,/api/prompts,/api/agent-registry,/api/actions/audit,/api/jobs,/api/channels,/api/notifications/rules,/api/builder/projects,/api/builder/models,/api/builder/workflows,/api/builder/runs,/api/traces/gateway,/api/audit/chain-status,/api/gateway/showback,/api/gateway/keys,/api/settings/access,/api/settings/state,/api/governance/policies,/api/governance/rbac/me,/api/governance/approvals,/api/governance/secrets,/api/governance/budgets,/api/governance/retention,/api/orchestrator/lanes,/api/orchestrator/instances,/api/tenants,/api/projects,/api/sso/config}"

IFS=',' read -ra spa_routes <<< "$SPA_ROUTES"
for route in "${spa_routes[@]}"; do
  [[ -n "$route" ]] && check_spa_route "$route"
done

IFS=',' read -ra public_apis <<< "$PUBLIC_APIS"
for api in "${public_apis[@]}"; do
  [[ -n "$api" ]] && check_json_api "public" "$api"
done

IFS=',' read -ra protected_apis <<< "$PROTECTED_APIS"
for api in "${protected_apis[@]}"; do
  [[ -n "$api" ]] && check_json_api "protected" "$api" "x-operator-token: $TOKEN"
done

if [[ "$failures" -gt 0 ]]; then
  echo "FAILED: $failures route/API check(s) failed" >&2
  exit 1
fi

echo "PASS: all route/API checks passed"
