#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
TOKEN="${OPERATOR_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "OPERATOR_TOKEN is required" >&2
  exit 2
fi

check_json() {
  local path="$1"
  local url="${BASE_URL%/}$path"
  local response status body

  response="$(curl -sS -w $'\n%{http_code}' -H "x-operator-token: $TOKEN" "$url")"
  status="$(printf '%s' "$response" | tail -n 1)"
  body="$(printf '%s' "$response" | sed '$d')"

  if [[ "$status" != "200" ]]; then
    echo "FAIL $path -> HTTP $status" >&2
    printf '%s\n' "$body" >&2
    exit 1
  fi

  if ! printf '%s' "$body" | bun -e 'JSON.parse(await Bun.stdin.text())' >/dev/null; then
    echo "FAIL $path -> response is not valid JSON" >&2
    printf '%s\n' "$body" >&2
    exit 1
  fi

  echo "OK   $path"
}

check_json "/api/auth/status"
check_json "/api/builder/workflows"
check_json "/api/models"
