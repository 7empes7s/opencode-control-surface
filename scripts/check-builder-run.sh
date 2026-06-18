#!/usr/bin/env bash
set -euo pipefail

RUN_ID="${1:-}"
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
TOKEN="${OPERATOR_TOKEN:-}"
STALE_SECONDS="${STALE_SECONDS:-2700}"

if [[ -z "$RUN_ID" ]]; then
  echo "usage: $0 <runId>" >&2
  exit 2
fi

if [[ -z "$TOKEN" ]]; then
  echo "OPERATOR_TOKEN is required" >&2
  exit 2
fi

url="${BASE_URL%/}/api/builder/runs/$RUN_ID"
tmp="$(mktemp)"
status="$(curl -sS --max-time 12 -o "$tmp" -w '%{http_code}' -H "x-operator-token: $TOKEN" "$url" || true)"

if [[ "$status" != "200" ]]; then
  echo "FAIL run $RUN_ID -> HTTP $status" >&2
  sed -n '1,20p' "$tmp" >&2
  rm -f "$tmp"
  exit 1
fi

set +e
RUN_ID_ENV="$RUN_ID" STALE_SECONDS_ENV="$STALE_SECONDS" bun -e '
const runId = process.env.RUN_ID_ENV;
const staleSeconds = Number.parseInt(process.env.STALE_SECONDS_ENV ?? "2700", 10);
const payload = JSON.parse(await Bun.stdin.text());
const data = payload.data ?? payload;
const run = data.run;

if (!run) {
  console.error(`FAIL run ${runId} -> not found`);
  process.exit(1);
}

const passes = Array.isArray(data.passes) ? data.passes : [];
const validations = Array.isArray(data.validations) ? data.validations : [];
const workflow = data.workflow ?? null;
const lastPass = passes.at(-1) ?? null;
const failedValidation = validations.find((validation) => validation.status && !["success", "passed", "ok"].includes(String(validation.status).toLowerCase())) ?? null;
const now = Date.now();
const lastActivity = Math.max(
  run.finishedAt ?? 0,
  run.startedAt ?? 0,
  lastPass?.finishedAt ?? 0,
  lastPass?.startedAt ?? 0,
  ...validations.map((validation) => validation.finishedAt ?? validation.startedAt ?? 0),
);
const stale = run.status === "running" && lastActivity > 0 && now - lastActivity > staleSeconds * 1000;

function fmtTs(value) {
  return value ? new Date(value).toISOString() : "n/a";
}

function duration(startedAt, finishedAt) {
  if (!startedAt) return "n/a";
  const end = finishedAt ?? now;
  return `${Math.max(0, Math.round((end - startedAt) / 1000))}s`;
}

console.log(`Run: ${run.id}`);
console.log(`Status: ${run.status}`);
console.log(`Workflow: ${run.workflowId}${workflow?.name ? ` (${workflow.name})` : ""}`);
console.log(`Started: ${fmtTs(run.startedAt)}`);
console.log(`Finished: ${fmtTs(run.finishedAt)}`);
console.log(`Last activity: ${fmtTs(lastActivity)}${stale ? " (STALED)" : ""}`);

if (lastPass) {
  console.log(`Last pass: #${lastPass.sequence} ${lastPass.status} ${lastPass.agent ?? "unknown-agent"} ${lastPass.model ?? "unknown-model"} ${duration(lastPass.startedAt, lastPass.finishedAt)}`);
  if (lastPass.failureClass || lastPass.error) {
    console.log(`Last pass failure: ${lastPass.failureClass ?? "unknown"} ${lastPass.error ?? ""}`.trim());
  }
} else {
  console.log("Last pass: none");
}

if (failedValidation) {
  console.log(`Last validation failure: ${failedValidation.kind} ${failedValidation.status} ${failedValidation.command ?? failedValidation.url ?? ""}`.trim());
  if (failedValidation.error) console.log(`Validation error: ${failedValidation.error}`);
} else {
  console.log("Last validation failure: none");
}

const projectRoot = workflow?.config?.projectRoot ?? workflow?.projectRoot ?? workflow?.root ?? null;
console.log(`Project root: ${projectRoot ?? "unknown"}`);

if (stale) process.exitCode = 1;
' < "$tmp"
script_status=$?
set -e

project_root="$(bun -e 'const payload = JSON.parse(await Bun.stdin.text()); const data = payload.data ?? payload; const workflow = data.workflow ?? {}; const root = workflow.config?.projectRoot ?? workflow.projectRoot ?? workflow.root ?? ""; if (root) console.log(root);' < "$tmp")"
rm -f "$tmp"

if [[ -n "$project_root" && -d "$project_root/.git" ]]; then
  echo "Generated project dirty summary:"
  git -C "$project_root" status --short | head -40 || true
elif [[ -n "$project_root" ]]; then
  echo "Generated project dirty summary: $project_root is not a git worktree"
else
  echo "Generated project dirty summary: unavailable"
fi

exit "$script_status"
