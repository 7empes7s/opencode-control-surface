#!/usr/bin/env bash
# SPEC 6 (ULTRAPLAN P1.4) -- cold-install terminal clip.
#
# Produces e2e/demo/clips/cold-install.cast: a real asciinema recording of
#   install.sh prereq checks -> bun install/build -> operator token printed
#   -> server start -> curl / 200, with visible wall-clock timestamps.
#
# Boots a FRESH oven/bun:1 container (name cs-demorec, host port 4620, capped
# --memory 2g --cpus 2) from a working-tree archive (same idiom as
# e2e/fresh-host/run.sh: `git ls-files --cached --others --exclude-standard`,
# so no VPS state -- node_modules, dist, *.db, .env -- leaks in), with
# DEMO_SEED=1 so the server seeds the "Northstar Showcase Demo" tenant on
# boot. install.sh itself runs INSIDE the container as the recorded process
# (not a hand-rolled docker run comment) so the clip shows the real prereq
# checks and the real generated-token banner.
#
# Usage:
#   e2e/demo/record-cold-install.sh              # record the clip, leave the container running
#   e2e/demo/record-cold-install.sh --teardown   # remove the container when done with it
#
# Hard rails: never touches the live :3000 service, never runs systemctl,
# never commits/pushes. Container is capped, named cs-demorec, and only ever
# torn down by --teardown (or e2e/demo/record-wizard.mjs's caller) -- never a
# broad `docker rm` / pkill.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="cs-demorec"
IMAGE="oven/bun:1"
HOST_PORT="${DEMOREC_PORT:-4620}"
WORKDIR="${DEMOREC_WORKDIR:-/tmp/cs-demorec-work}"
SRC="$WORKDIR/src"
CLIPS_DIR="$REPO/e2e/demo/clips"
CAST="$CLIPS_DIR/cold-install.cast"
INNER_SCRIPT="$WORKDIR/cold-install-inner.sh"

if [ "${1:-}" = "--teardown" ]; then
  echo "[record-cold-install] removing $CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "[record-cold-install] done"
  exit 0
fi

mkdir -p "$CLIPS_DIR" "$WORKDIR"

echo "[record-cold-install] removing any previous $CONTAINER container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "[record-cold-install] archiving working tree (tracked + untracked-not-ignored) -> $SRC"
rm -rf "$SRC"
mkdir -p "$SRC"
git -C "$REPO" ls-files -z --cached --others --exclude-standard | tar -cf - --null -C "$REPO" -T - | tar -x -C "$SRC"

# The inner script is what asciinema actually records. Kept as its own file
# (rather than inlined into `asciinema rec --command "..."`) so quoting stays
# simple and the terminal shows exactly the commands a human operator would
# run -- no shell escaping noise in the cast.
cat > "$INNER_SCRIPT" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
SRC="$1"
CONTAINER="$2"
HOST_PORT="$3"

echo "=== Control Surface -- cold install on a fresh host (oven/bun:1 container) ==="
date -u +"%Y-%m-%dT%H:%M:%SZ"
echo

echo "\$ docker run -d --name $CONTAINER --memory 2g --cpus 2 -p ${HOST_PORT}:3000 -e DEMO_SEED=1 oven/bun:1 ./install.sh"
docker run -d \
  --name "$CONTAINER" \
  --memory 2g --cpus 2 \
  -p "${HOST_PORT}:3000" \
  -v "$SRC:/app" \
  -w /app \
  -e DEMO_SEED=1 \
  oven/bun:1 \
  sh -c "./install.sh --env-file /app/control-surface.env --port 3000" \
  >/dev/null
echo "container started: $CONTAINER"
echo

echo "--- following install.sh output live ---"
echo
docker logs -f "$CONTAINER" &
LOGPID=$!

for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Let the last few log lines (server listening, seed banner) flush before
# detaching the tail.
sleep 2
kill "$LOGPID" 2>/dev/null || true
wait "$LOGPID" 2>/dev/null || true

echo
date -u +"%Y-%m-%dT%H:%M:%SZ"
echo "\$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:${HOST_PORT}/"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' "http://localhost:${HOST_PORT}/"
echo
echo "=== cold install complete -- control surface is up at http://localhost:${HOST_PORT} ==="
INNER
chmod +x "$INNER_SCRIPT"

echo "[record-cold-install] recording with asciinema -> $CAST"
asciinema rec --overwrite -y -q --cols 100 --rows 32 \
  --command "bash '$INNER_SCRIPT' '$SRC' '$CONTAINER' '$HOST_PORT'" \
  "$CAST"

echo "[record-cold-install] clip written: $CAST ($(du -h "$CAST" | cut -f1))"
echo "[record-cold-install] container '$CONTAINER' is left running at http://localhost:${HOST_PORT} for the wizard clip"
echo "[record-cold-install] operator token / env file: $SRC/control-surface.env"
echo "[record-cold-install] tear it down when done: $0 --teardown  (or: docker rm -f $CONTAINER)"
