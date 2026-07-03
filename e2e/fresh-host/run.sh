#!/usr/bin/env bash
# Fresh-host harness (ULTRAPLAN P0.1-0.3).
#
# Proves the control surface boots honestly on a machine that is NOT this VPS:
#   1. Archives the current git HEAD (tracked files only -- no node_modules,
#      no dist, no *.db, no .env -- so no VPS state leaks into the container).
#   2. Boots it in a resource-capped, network-isolated-from-real-services
#      container with ONLY the minimal env the spec allows.
#   3. Probes every no-param GET /api/* + /v1/* route (extracted live from
#      server/api/router.ts) plus "/", and classifies each response as
#      HONEST / LEAK / CRASH / ERROR-5xx.
#   4. Writes e2e/fresh-host/REPORT.md.
#
# Hard rails: never touches the live :3000 service, never runs systemctl,
# never commits/pushes. Container is capped --memory 2g --cpus 2, named
# cs-freshhost, and removed on every entry/exit of this script.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="cs-freshhost"
IMAGE="oven/bun:1"
HOST_PORT="${FRESH_HOST_PORT:-4600}"
WORKDIR="${FRESH_HOST_WORKDIR:-/tmp/cs-freshhost-work}"
SRC="$WORKDIR/src"
NODE_MODULES_CACHE="$WORKDIR/node_modules-cache"
REPORT_DIR="$REPO/e2e/fresh-host"
REPORT_MD="$REPORT_DIR/REPORT.md"
BOOT_LOG="$WORKDIR/boot.log"
TOKEN="fresh-smoke-token"
MAX_WAIT_ITERS="${FRESH_HOST_MAX_WAIT_ITERS:-150}"  # 150 * 2s = 5 min for install+build+boot

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[run.sh] removing any previous $CONTAINER container"
cleanup

echo "[run.sh] preparing clean archived source tree at $SRC"
mkdir -p "$WORKDIR"
# Preserve node_modules across runs (huge iteration speedup) but never let it
# leak into the archive step -- it lives outside $SRC while we re-extract.
if [ -d "$SRC/node_modules" ] && [ ! -L "$SRC/node_modules" ]; then
  rm -rf "$NODE_MODULES_CACHE"
  mv "$SRC/node_modules" "$NODE_MODULES_CACHE"
fi
rm -rf "$SRC"
mkdir -p "$SRC"
# NOTE: intentionally NOT `git archive HEAD` -- that freezes on the last commit
# and would never see uncommitted fixes made during this harness's fix/re-run
# loop (and the hard rails forbid committing just to make the harness see
# them). `git ls-files` lists tracked, non-gitignored paths; tarring those
# straight off the working tree picks up in-progress edits while still
# guaranteeing no untracked VPS state (node_modules, dist, *.db, .env, secrets)
# leaks into the fresh-host container.
git -C "$REPO" ls-files -z | tar -cf - --null -C "$REPO" -T - | tar -x -C "$SRC"
if [ -d "$NODE_MODULES_CACHE" ]; then
  mv "$NODE_MODULES_CACHE" "$SRC/node_modules"
fi

echo "[run.sh] booting container ($IMAGE, memory=2g cpus=2, port $HOST_PORT->3000)"
docker run -d \
  --name "$CONTAINER" \
  --memory 2g --cpus 2 \
  -p "${HOST_PORT}:3000" \
  -v "$SRC:/app" \
  -w /app \
  -e PORT=3000 \
  -e DASHBOARD_DB=1 \
  -e DASHBOARD_DB_PATH=/tmp/fresh.sqlite \
  -e OPERATOR_TOKEN="$TOKEN" \
  "$IMAGE" \
  sh -c "(bun install --frozen-lockfile || bun install) && bun run build && exec bun run server/index.ts" \
  >/dev/null

echo "[run.sh] waiting for boot (max ${MAX_WAIT_ITERS}x2s)..."
BOOTED=0
for i in $(seq 1 "$MAX_WAIT_ITERS"); do
  if curl -fsS "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
    BOOTED=1
    break
  fi
  if ! docker ps --filter "name=${CONTAINER}" --filter "status=running" --format '{{.Names}}' | grep -q "^${CONTAINER}\$"; then
    echo "[run.sh] container exited early"
    break
  fi
  sleep 2
done

docker logs "$CONTAINER" > "$BOOT_LOG" 2>&1 || true

if [ "$BOOTED" != "1" ]; then
  echo "[run.sh] WARNING: server did not become healthy within timeout -- probing anyway to record the failure"
else
  echo "[run.sh] healthy -- letting async DB init/seeding settle"
  sleep 5
fi

echo "[run.sh] running probe against http://localhost:${HOST_PORT}"
PROBE_EXIT=0
bun run "$REPORT_DIR/probe.mjs" "$REPO/server/api/router.ts" "http://localhost:${HOST_PORT}" "$TOKEN" "$REPORT_MD" || PROBE_EXIT=$?

{
  echo ""
  echo "## Container boot log (tail)"
  echo ""
  echo '```'
  tail -n 120 "$BOOT_LOG" 2>/dev/null || echo "(no boot log captured)"
  echo '```'
} >> "$REPORT_MD"

echo "[run.sh] report written to $REPORT_MD"
exit "$PROBE_EXIT"
