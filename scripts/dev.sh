#!/usr/bin/env bash
# dev.sh — Orchestrates the development environment with automatic port collision resolution.
#
# 1. Idempotently ensures infrastructure is running (Cluster, Gitea, Temporal, Mongo, Headscale, Infisical).
# 2. Checks target development ports (3001, 8000, 5173) and terminates any stale orphaned dev processes.
# 3. Terminates any stale Temporal worker processes so workers always run fresh, current code.
# 4. Concurrently launches backend, frontend, and workers with clean logging.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Never run under sudo
if [ "$(id -u)" -eq 0 ]; then
  echo "❌ Do not run 'npm run dev' (or this script) with sudo — it leaves dev-server files"
  echo "   root-owned. Sudo will be prompted interactively only when strictly required."
  exit 1
fi

echo "═══════════════════════════════════════════════════════════════════════"
echo "🚀 INITIALIZING PROVISIONING DEV ENVIRONMENT"
echo "═══════════════════════════════════════════════════════════════════════"

# ── 1. INFRASTRUCTURE ENSURE ─────────────────────────────────────────
echo "▶ [1/3] Ensuring platform infrastructure services..."
bash "${ROOT}/scripts/ensure-cluster.sh"
bash "${ROOT}/scripts/ensure-gitea.sh"
bash "${ROOT}/scripts/ensure-temporal.sh"
bash "${ROOT}/scripts/ensure-mongo.sh"
bash "${ROOT}/scripts/ensure-headscale.sh"
if [ -n "${WITH_INFISICAL:-}" ]; then
  bash "${ROOT}/scripts/ensure-infisical.sh"
fi

# ── 2. PORT & PROCESS RECLAIM ────────────────────────────────────────
echo "▶ [2/3] Checking ports and resolving stale processes..."

reclaim_port() {
  local port="$1"
  local name="$2"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti :${port} 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser ${port}/tcp 2>/dev/null || true)"
  fi

  if [ -n "$pids" ]; then
    echo "  ⚠️  Port ${port} (${name}) is currently in use by PID(s): ${pids}"
    echo "      Reclaiming port for clean foreground session..."
    for pid in $pids; do
      if [ "$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$(id -u)" ]; then
        kill "$pid" 2>/dev/null || true
      fi
    done

    # Wait up to 2 seconds for clean exit
    local deadline=$(( $(date +%s) + 2 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      local check=""
      if command -v lsof >/dev/null 2>&1; then
        check="$(lsof -ti :${port} 2>/dev/null || true)"
      else
        check="$(fuser ${port}/tcp 2>/dev/null || true)"
      fi
      if [ -z "$check" ]; then
        break
      fi
      sleep 0.2
    done

    # Force kill if still lingering
    local remaining=""
    if command -v lsof >/dev/null 2>&1; then
      remaining="$(lsof -ti :${port} 2>/dev/null || true)"
    else
      remaining="$(fuser ${port}/tcp 2>/dev/null || true)"
    fi
    if [ -n "$remaining" ]; then
      for pid in $remaining; do
        if [ "$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$(id -u)" ]; then
          kill -9 "$pid" 2>/dev/null || true
        fi
      done
      sleep 0.3
    fi
    echo "  ✅  Port ${port} reclaimed"
  fi
}

reclaim_port 3001 "Backend API"
reclaim_port 8000 "Host Tunnel"
reclaim_port 5173 "Frontend Vite"

# Also terminate any stale worker processes from previous sessions
# Workers do not hot-reload and must start fresh
STALE_WORKERS=$(pgrep -u "$(id -u)" -f "worker-host|worker-cluster" 2>/dev/null || true)
if [ -n "$STALE_WORKERS" ]; then
  echo "  ⚠️  Reclaiming stale Temporal workers (PID: ${STALE_WORKERS})..."
  kill $STALE_WORKERS 2>/dev/null || true
  sleep 0.3
fi

# ── 3. DEV PROCESS ORCHESTRATION ────────────────────────────────────
echo "▶ [3/3] Starting development stack with live log streaming..."
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Backend API:  http://localhost:3001"
echo "  Frontend UI:  http://localhost:5173"
echo "  Host Tunnel:  http://localhost:8000"
echo "  Temporal:     http://localhost:7233"
echo "  MongoDB:      mongodb://localhost:27017"
echo "  Headscale:    http://localhost:8080"
echo "═══════════════════════════════════════════════════════════════════════"

exec npx concurrently --kill-others \
  --names "backend,frontend,worker-host,worker-cluster" \
  --prefix-colors "blue,cyan,yellow,magenta" \
  "npm run dev -w apps/backend" \
  "npm run dev -w apps/frontend" \
  "npm run dev:worker -w apps/backend" \
  "npm run dev:worker:cluster -w apps/backend"
