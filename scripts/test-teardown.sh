#!/usr/bin/env bash
# test-teardown — Kill backend/frontend/k3d dev servers started by test:setup.
set -euo pipefail

ROOT="$(cd "$(dirname -- "$(dirname -- "$0")")" && pwd)"
PID_FILE="$ROOT/.test-server-state/pids"

cleanup_pid() {
  local name="$1"
  if [ -f "$PID_FILE/${name}.pid" ]; then
    local pid
    pid=$(<"$PID_FILE/${name}.pid")
    kill "$pid" 2>/dev/null || true
    pkill -P "$pid" 2>/dev/null || true
    pkill -P -"$pid" 2>/dev/null || true
    sleep 2
    rm -f "$PID_FILE/${name}.pid"
    echo "  ✖  killed  $name"
  else
    echo "  ✖  no pid file  $name"
  fi
}

rm -f "$PID_FILE/backend.pid" "$PID_FILE/frontend.pid" 2>/dev/null || true
cleanup_pid backend
cleanup_pid frontend
kill "$(cat "$PID_FILE/k3d.pid" 2>/dev/null)" 2>/dev/null || true
rm -f "$PID_FILE/k3d.pid"
pkill -f "k3d-Lunorica-local-server-0" 2>/dev/null || true
sleep 1

echo "  ✖  teardown done"
