#!/usr/bin/env bash
# Dev stack launcher: sidecar -> health gate -> backend.
# Only kills process trees it started; a port owner it did not start is reported
# and left alone.

set -uo pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_PORT="${SIDECAR_PORT:-9000}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-45}"
SKIP_PORT_CHECK="${SKIP_PORT_CHECK:-0}"
LOG_DIR="$ROOT/.tmp/logs"

PIDS=()
NAMES=()
CLEANED=0
INTERRUPTED=0
LAST_PID=""
SIDECAR_PID=""
WATCHER_PID=""
STAMP="$LOG_DIR/.sidecar-stamp"

log() { printf '[dev] %s\n' "$*"; }
fail() { printf '[dev] ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '[dev]   %s\n' "$*"; }

resolve_python() {
  local candidate
  for candidate in \
    "$ROOT/sidecar/.venv/Scripts/python.exe" \
    "$ROOT/sidecar/.venv/bin/python" \
    "$(command -v python3 2>/dev/null || true)" \
    "$(command -v python 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

PY="$(resolve_python)" || fail "Python/sidecar venv not found. Create sidecar/.venv first."
[[ -d "$ROOT/backend/node_modules" ]] || fail "backend/node_modules missing. Run: cd backend && npm install"
mkdir -p "$LOG_DIR"
: > "$LOG_DIR/sidecar.log"
: > "$LOG_DIR/backend.log"

# Single netstat snapshot per check: a `netstat | awk` pipeline per port forks
# three times, and MSYS bash runs out of fork under repeated forking.
port_pid() {
  local port="$1" snapshot="${2:-}"
  if [[ -z "$snapshot" ]]; then
    snapshot="$(netstat -ano 2>/dev/null)"
  fi
  awk -v needle=":$port" '$2 ~ needle && $4 == "LISTENING" { print $5; exit }' <<<"$snapshot"
}

preflight_ports() {
  [[ "$SKIP_PORT_CHECK" == "1" ]] && return 0
  local snapshot occupied=0 label port pid
  snapshot="$(netstat -ano 2>/dev/null)"
  while read -r label port; do
    pid="$(port_pid "$port" "$snapshot")"
    if [[ -n "$pid" ]]; then
      printf '[dev] Port %s (%s) is already in use by PID %s. Leaving it alone.\n' \
        "$port" "$label" "$pid" >&2
      occupied=1
    fi
  done <<EOF
sidecar $SIDECAR_PORT
backend $BACKEND_PORT
EOF
  (( occupied == 0 )) || fail "Stop the listed owner(s), or set SKIP_PORT_CHECK=1 if you know what you are doing."
}

is_windows_git_bash() {
  [[ "${OSTYPE:-}" == msys* || "${MSYSTEM:-}" != "" ]]
}

pid_alive() {
  kill -0 "$1" 2>/dev/null
}

windows_pid() {
  local msys_pid="$1"
  # `$!`/`kill` use MSYS PIDs; taskkill needs Windows PIDs. Mixing them orphans
  # node/python children that keep holding the port.
  ps -W 2>/dev/null | awk -v pid="$msys_pid" '$1 == pid { print $4; exit }'
}

stop_tree() {
  local pid="$1" force="${2:-0}"
  pid_alive "$pid" || return 0
  if is_windows_git_bash && command -v taskkill >/dev/null 2>&1; then
    local winpid
    winpid="$(windows_pid "$pid")"
    [[ -n "$winpid" ]] || { kill -TERM "$pid" 2>/dev/null || true; return 0; }
    if [[ "$force" == "1" ]]; then
      taskkill //PID "$winpid" //T //F >/dev/null 2>&1 || true
    else
      taskkill //PID "$winpid" //T >/dev/null 2>&1 || true
    fi
  else
    if [[ "$force" == "1" ]]; then
      kill -KILL "$pid" 2>/dev/null || true
    else
      kill -TERM "$pid" 2>/dev/null || true
    fi
  fi
}

cleanup() {
  (( CLEANED == 0 )) || return 0
  CLEANED=1
  trap '' INT TERM
  log "Stopping owned process trees..."
  local i pid
  [[ -n "$WATCHER_PID" ]] && stop_tree "$WATCHER_PID" 0
  for ((i=${#PIDS[@]}-1; i>=0; i--)); do
    stop_tree "${PIDS[$i]}" 0
  done
  local deadline=$((SECONDS + 5))
  while (( SECONDS < deadline )); do
    local alive=0
    for pid in "${PIDS[@]}"; do pid_alive "$pid" && alive=1; done
    (( alive == 0 )) && break
    sleep 0.2
  done
  for pid in "${PIDS[@]}"; do stop_tree "$pid" 1; done
  [[ -n "$WATCHER_PID" ]] && stop_tree "$WATCHER_PID" 1
}

on_interrupt() {
  INTERRUPTED=1
  cleanup
  exit 130
}

trap on_interrupt INT TERM
trap cleanup EXIT

start_child() {
  local name="$1" cwd="$2" logfile="$3"
  shift 3
  (
    cd "$cwd" || exit 1
    exec "$@"
  ) >>"$logfile" 2>&1 &
  LAST_PID=$!
  PIDS+=("$LAST_PID")
  NAMES+=("$name")
}

health_ok() {
  local url="$1"
  "$PY" - "$url" <<'PY' >/dev/null 2>&1
import sys
from urllib.request import urlopen
try:
    with urlopen(sys.argv[1], timeout=1.5) as response:
        raise SystemExit(0 if 200 <= response.status < 300 else 1)
except Exception:
    raise SystemExit(1)
PY
}

wait_for_health() {
  local name="$1" url="$2" timeout="$3" logfile="$4"
  local deadline=$((SECONDS + timeout))
  until health_ok "$url"; do
    if (( SECONDS >= deadline )); then
      printf '[dev] %s did not become healthy in %ss. Last log lines:\n' "$name" "$timeout" >&2
      tail -20 "$logfile" >&2 || true
      return 1
    fi
    sleep 0.5
  done
  log "$name healthy: $url"
}

# Fork-free change detection: spawn a Python process every second (the previous
# approach) exhausts MSYS bash's fork budget and makes later port checks fail
# silently, which is what left orphan listeners behind.
touch "$STAMP"
sidecar_changed() {
  local file
  for file in "$ROOT"/sidecar/app/**/*.py "$ROOT"/sidecar/app/*.py; do
    [[ "$file" -nt "$STAMP" ]] && return 0
  done
  return 1
}

start_sidecar() {
  start_child sidecar "$ROOT/sidecar" "$LOG_DIR/sidecar.log" \
    "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$SIDECAR_PORT"
  SIDECAR_PID="$LAST_PID"
  touch "$STAMP"
}

# Uvicorn's Windows reloader sends CTRL_C_EVENT then waits with an unbounded
# join, so a worker holding the backend WebSocket can hang at "Reloading...".
# The launcher owns the tree, so it restarts that tree and lets the backend
# reconnect.
restart_sidecar() {
  local old_pid="$SIDECAR_PID"
  log "Python source changed; restarting sidecar"
  stop_tree "$old_pid" 0
  local deadline=$((SECONDS + 5))
  while pid_alive "$old_pid" && (( SECONDS < deadline )); do sleep 0.2; done
  stop_tree "$old_pid" 1
  local i
  for i in "${!PIDS[@]}"; do
    [[ "${PIDS[$i]}" == "$old_pid" ]] && PIDS[$i]=""
  done
  start_sidecar
  log "sidecar restarted (PID $SIDECAR_PID)"
  if ! wait_for_health sidecar "http://127.0.0.1:${SIDECAR_PORT}/health" "$HEALTH_TIMEOUT" "$LOG_DIR/sidecar.log"; then
    log "Sidecar restart failed; the watcher retries on the next source change."
  fi
}

# Surface the events that matter without dumping full logs. One pipeline, so it
# costs three forks once instead of forking per line.
KEY_EVENTS='Connected to Whisper|Disconnected from sidecar|Reconnecting to Whisper|Source switch|Source change seen|Reset: dropped|Application startup complete|Shutting down|Traceback|ERROR'
start_log_stream() {
  [[ "${DEV_QUIET:-0}" == "1" ]] && return 0
  tail -n 0 -F "$LOG_DIR/sidecar.log" "$LOG_DIR/backend.log" 2>/dev/null \
    | grep --line-buffered -E "$KEY_EVENTS" \
    | sed --unbuffered -E 's/^\[[0-9;]*m//g; s/[[:space:]]+$//' \
    | while IFS= read -r line; do printf '  | %s\n' "$line"; done &
  WATCHER_PID=$!
}

preflight_ports

start_sidecar

wait_for_health sidecar "http://127.0.0.1:${SIDECAR_PORT}/health" "$HEALTH_TIMEOUT" "$LOG_DIR/sidecar.log" \
  || exit 1

start_child backend "$ROOT/backend" "$LOG_DIR/backend.log" \
  env PORT="$BACKEND_PORT" npm run start:dev

log "Logs: ${LOG_DIR#$ROOT/}/{sidecar,backend}.log   (DEV_QUIET=1 to silence the stream below)"
log "Extension edits still need: cd extension && npm run build, then Chrome Reload"
log "Ctrl+C stops only this stack."

start_log_stream

# Warn rather than abort: `nest start --watch` needs a first compile.
if ! wait_for_health backend "http://127.0.0.1:${BACKEND_PORT}/health" 30 "$LOG_DIR/backend.log"; then
  log "Backend is still compiling; follow ${LOG_DIR#$ROOT/}/backend.log"
fi

log "Ready"

while :; do
  sleep 1
  if sidecar_changed; then
    restart_sidecar
  elif ! pid_alive "$SIDECAR_PID"; then
    log "Sidecar exited unexpectedly; restarting"
    restart_sidecar
  fi

  for i in "${!PIDS[@]}"; do
    pid="${PIDS[$i]}"
    if [[ -n "$pid" ]] && ! pid_alive "$pid"; then
      log "${NAMES[$i]} exited (PID $pid); see ${LOG_DIR#$ROOT/}/${NAMES[$i]}.log"
      PIDS[$i]=""
    fi
  done

  any=0
  for pid in "${PIDS[@]}"; do [[ -n "$pid" ]] && pid_alive "$pid" && any=1; done
  (( any == 1 )) || break
done

(( INTERRUPTED == 0 )) || exit 130
exit 1
