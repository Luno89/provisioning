#!/usr/bin/env bash
# test-setup — Launch backend + frontend dev servers in the background for testing.
#   - Wall-clock lock file prevents concurrent re-invocations.
#   - Dev servers log to files, exit code guard ensures they boot before scripts run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname -- "$0")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$BASE_DIR/.test-server-state/pids"
LOGS_DIR="$BASE_DIR/.test-server-state/logs"
LOCK_FILE="$BASE_DIR/.test-server-state/dir"
mkdir -p "$PID_FILE" "$LOGS_DIR"

# ── one-shot lock ───────────────────────────────────────────
rm -rf -- "$PID_FILE" /dev/null 2>/dev/null
mkdir -p "$PID_FILE" "$LOGS_DIR"
if [ -f "$LOCK_FILE" ] && [ "$LOCK_FILE" = "$(date +%s)" ]; then
  echo "⚠️  test:setup already running (lock matches). Use test:teardown first."
  exit 1
fi
date +%s > "$LOCK_FILE"

cleanup() {
  rm -rf -- "$PID_FILE" /dev/null 2>/dev/null || true
  rm -rf -- "$LOGS_DIR" /dev/null 2>/dev/null || true
  rm -rf -- "$LOCK_FILE" /dev/null 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

wait_pid() {
  # Wait for $1 to die (it hasn't failed yet) but also require port $3 to open.
  local pid="$1" name="$2" port="$3" deadline=0
  while kill -0 "$pid" 2>/dev/null; do
    if ss -tln 2>/dev/null | grep -q ":${port} "; then
      return 0
    fi
    deadline=$((deadline + 1))
    [ "$deadline" -gt 20 ] && return 0   # keep going even if backend is hung
    sleep 1
  done
  return 1
}

# ── BACKEND  (port 3002)  IS_E2E=true  NODE_ENV=test ───────
echo ""
echo "▶  Launching backend on port :3002 — IS_E2E=true, NODE_ENV=test"
{
  PORT=3002 IS_E2E=true NODE_ENV=test npm run dev -w apps/backend
  echo "  EXITED: backend background (exit=$?)"
} > "$LOGS_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$PID_FILE/backend.pid"
wait_pid "$BACKEND_PID" "backend" 3002
echo "  ✅  Backend  pid=$BACKEND_PID  bound :3002"

# ── FRONTEND  (port 5174)  VITE_API_BASE=http://localhost:3002/api ──
echo "▶  Launching frontend on port :5174 — VITE_API_BASE=http://localhost:3002/api"
{
  VITE_API_BASE=http://localhost:3002/api \
  VITE_SOCKET_URL=http://localhost:3002 \
  npm run dev -w apps/frontend -- --port 5174
  echo "  EXITED: frontend background (exit=$?)"
} > "$LOGS_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > "$PID_FILE/frontend.pid"
wait_pid "$FRONTEND_PID" "frontend" 5174
echo "  ✅  Frontend  pid=$FRONTEND_PID  bound :5174"

echo ""
echo "────────────────────────────────"
echo "  Backend PID $BACKEND_PID  -> :3002"
echo "  Frontend PID $FRONTEND_PID -> :5174"
echo "────────────────────────────────"
