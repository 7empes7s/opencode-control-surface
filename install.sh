#!/usr/bin/env bash
# Control Surface — cold-install script (ULTRAPLAN P0.5 / SPEC 5).
#
# Bare host -> login screen in under 10 minutes with one documented command:
#
#   ./install.sh                 # install + start in the foreground
#   ./install.sh --check         # dry run: validate prerequisites, print the plan
#   ./install.sh --systemd       # install + emit a systemd unit (stdout) instead of starting
#   ./install.sh --systemd unit.service   # ...or write the unit to a file
#
# Design notes:
#   - Idempotent / safe to re-run: reuses an existing checkout, an existing
#     OPERATOR_TOKEN in the env file, and `bun install` is a no-op when
#     node_modules already matches the lockfile.
#   - Never auto-installs system packages. If a genuinely required tool is
#     missing, this script prints an honest hint for the operator to run
#     themselves and exits non-zero -- it does not apt-get/brew/curl-pipe
#     anything on your behalf.
#   - Never runs systemctl. --systemd only ever emits unit text (to stdout or
#     to a file); installing/enabling it is the operator's own step.
set -euo pipefail

# ── defaults ─────────────────────────────────────────────────────────────
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SCRIPT_DIR="$(pwd)"
fi

REPO_URL="${INSTALL_REPO_URL:-https://github.com/7empes7s/opencode-control-surface.git}"
TARGET_DIR="${INSTALL_DIR:-}"
ENV_FILE="${ENV_FILE:-}"
PORT="${PORT:-3000}"
CHECK_ONLY=0
EMIT_SYSTEMD=0
SYSTEMD_OUT=""

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

Options:
  --check              Dry run: validate prerequisites and print the install plan. No changes made.
  --dir <path>         Target directory for the repo checkout (default: this script's own directory,
                        i.e. "use the current checkout" when run in place).
  --env-file <path>    Path to write the generated environment file (default: <target>/control-surface.env).
  --port <port>        Port the server listens on (default: 3000).
  --systemd [path]     Emit a systemd unit (to stdout, or to <path> if given) instead of starting the
                        server in the foreground. This script NEVER calls systemctl itself -- install
                        the unit yourself:
                          sudo cp <unit> /etc/systemd/system/control-surface.service
                          sudo systemctl daemon-reload && sudo systemctl enable --now control-surface
  -h, --help           Show this help.

Environment overrides: INSTALL_REPO_URL, INSTALL_DIR, ENV_FILE, PORT, DASHBOARD_DB_PATH.
USAGE
}

log()  { echo "[install.sh] $*"; }
warn() { echo "[install.sh] WARNING: $*" >&2; }
fail() { echo "[install.sh] ERROR: $*" >&2; exit 1; }

# ── argument parsing ────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --dir) TARGET_DIR="${2:?--dir requires a path}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file requires a path}"; shift 2 ;;
    --port) PORT="${2:?--port requires a value}"; shift 2 ;;
    --systemd)
      EMIT_SYSTEMD=1
      if [ "${2:-}" != "" ] && [ "${2#--}" = "$2" ]; then SYSTEMD_OUT="$2"; shift 2; else shift; fi
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

# ── prerequisite checks: bun (hard), git (only if cloning), curl (soft) ──
HAVE_BUN=0; HAVE_GIT=0; HAVE_CURL=0
command -v bun  >/dev/null 2>&1 && HAVE_BUN=1  || true
command -v git  >/dev/null 2>&1 && HAVE_GIT=1  || true
command -v curl >/dev/null 2>&1 && HAVE_CURL=1 || true

log "prerequisite check: bun=$([ "$HAVE_BUN" = 1 ] && echo yes || echo NO) git=$([ "$HAVE_GIT" = 1 ] && echo yes || echo no) curl=$([ "$HAVE_CURL" = 1 ] && echo yes || echo no)"

if [ "$HAVE_BUN" != 1 ]; then
  echo ""
  echo "Missing prerequisite: bun (the JavaScript runtime this project requires)."
  echo "  Install it yourself, then re-run this script:"
  echo "    curl -fsSL https://bun.sh/install | bash"
  echo "  This script never installs system packages on your behalf."
  exit 1
fi

if [ "$HAVE_CURL" != 1 ]; then
  warn "curl not found. Not required by this script, but you'll want it to probe /health yourself afterward:"
  warn "  apt-get install -y curl   # Debian/Ubuntu"
  warn "  brew install curl         # macOS"
fi

# Resolve TARGET_DIR: reuse an existing checkout if we're sitting in one and
# no --dir was given; otherwise a fresh subdirectory next to the cwd.
is_this_repo() {
  [ -f "$1/package.json" ] && grep -q '"opencode-control-surface"' "$1/package.json" 2>/dev/null
}

if [ -z "$TARGET_DIR" ]; then
  if is_this_repo "$SCRIPT_DIR"; then
    TARGET_DIR="$SCRIPT_DIR"
  else
    TARGET_DIR="$(pwd)/opencode-control-surface"
  fi
fi

if is_this_repo "$TARGET_DIR"; then
  NEED_CLONE=0
else
  NEED_CLONE=1
fi

if [ "$NEED_CLONE" = 1 ] && [ "$HAVE_GIT" != 1 ]; then
  echo ""
  echo "Missing prerequisite: git (needed to clone the repository into $TARGET_DIR)."
  echo "  Install it yourself, then re-run this script:"
  echo "    apt-get install -y git   # Debian/Ubuntu"
  echo "    brew install git         # macOS"
  echo "  This script never installs system packages on your behalf."
  exit 1
fi

if [ -z "$ENV_FILE" ]; then
  ENV_FILE="$TARGET_DIR/control-surface.env"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  echo ""
  echo "=== Install plan (--check, no changes made) ==="
  echo "  target dir : $TARGET_DIR $([ "$NEED_CLONE" = 1 ] && echo '(will git clone)' || echo '(existing checkout, reused)')"
  echo "  env file   : $ENV_FILE"
  echo "  port       : $PORT"
  if [ "$NEED_CLONE" = 1 ]; then
    echo "  steps      : git clone -> bun install -> bun run build -> generate token + env file -> start server"
  else
    echo "  steps      : bun install -> bun run build -> generate token + env file (if missing) -> start server"
  fi
  echo ""
  echo "Prerequisites: bun=$([ "$HAVE_BUN" = 1 ] && echo OK || echo MISSING) git=$([ "$HAVE_GIT" = 1 ] && echo OK || echo MISSING) curl=$([ "$HAVE_CURL" = 1 ] && echo OK || echo 'MISSING (optional)')"
  exit 0
fi

# ── clone or reuse ───────────────────────────────────────────────────────
if [ "$NEED_CLONE" = 1 ]; then
  log "cloning $REPO_URL into $TARGET_DIR"
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
else
  log "using existing checkout at $TARGET_DIR"
fi

cd "$TARGET_DIR"

# ── install + build (idempotent) ─────────────────────────────────────────
log "bun install"
bun install --frozen-lockfile || bun install

log "bun run build"
bun run build

# ── operator token + env file (idempotent: reuse an existing token) ─────
DASHBOARD_DB_PATH="${DASHBOARD_DB_PATH:-$TARGET_DIR/data/dashboard.sqlite}"
mkdir -p "$(dirname "$DASHBOARD_DB_PATH")"

if [ -f "$ENV_FILE" ] && grep -q '^OPERATOR_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  log "$ENV_FILE already has an OPERATOR_TOKEN -- reusing it (re-run is idempotent; token is not reprinted)"
else
  TOKEN="$(bun -e 'const b = new Uint8Array(32); crypto.getRandomValues(b); console.log(Buffer.from(b).toString("hex"));')"
  ( umask 077
    cat > "$ENV_FILE" <<ENVEOF
PORT=$PORT
DASHBOARD_DB=1
DASHBOARD_DB_PATH=$DASHBOARD_DB_PATH
OPERATOR_TOKEN=$TOKEN
ENVEOF
  )
  chmod 600 "$ENV_FILE"
  echo ""
  echo "=== Operator token generated ==="
  echo "OPERATOR_TOKEN=$TOKEN"
  echo "Store this now -- it will not be printed again. It's saved (chmod 600) in $ENV_FILE."
  echo ""
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ "$EMIT_SYSTEMD" = 1 ]; then
  BUN_BIN="$(command -v bun)"
  UNIT_CONTENT="$(cat <<UNITEOF
[Unit]
Description=Control Surface
After=network.target

[Service]
Type=simple
WorkingDirectory=$TARGET_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$BUN_BIN run server/index.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF
)"
  if [ -n "$SYSTEMD_OUT" ]; then
    printf '%s\n' "$UNIT_CONTENT" > "$SYSTEMD_OUT"
    log "systemd unit written to $SYSTEMD_OUT -- this script never runs systemctl, install it yourself:"
    log "  sudo cp $SYSTEMD_OUT /etc/systemd/system/control-surface.service"
    log "  sudo systemctl daemon-reload && sudo systemctl enable --now control-surface"
  else
    printf '%s\n' "$UNIT_CONTENT"
    log "^ systemd unit above -- this script never runs systemctl, install it yourself (see --help)."
  fi
  exit 0
fi

log "starting control surface on :$PORT (foreground -- Ctrl+C to stop)"
log "once it's up: curl http://localhost:$PORT/health"
exec bun run server/index.ts
