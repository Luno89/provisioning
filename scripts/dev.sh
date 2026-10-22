#!/usr/bin/env bash
# dev.sh — Orchestrates the development environment with automatic port collision resolution.
#
# 1. Idempotently ensures infrastructure is running (Cluster, Gitea, npm registry mirror, Temporal, Mongo, Headscale, Infisical).
# 2. Checks target development ports (3001, 8000, 5173) and terminates any stale orphaned dev processes.
# 3. Terminates any stale Temporal worker processes so workers always run fresh, current code.
# 4. Concurrently launches backend, frontend, and workers with clean logging.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPLIT=false
[ "${1:-}" = "--split" ] && SPLIT=true
STEADY=false
[ "${1:-}" = "--steady" ] && STEADY=true
if [ "$STEADY" = true ]; then WORKER_HOST="npm run start:worker -w apps/backend"; WORKER_CLUSTER="npm run start:worker:cluster -w apps/backend"; WORKER_ENGINE="npm run start:worker:engine -w apps/backend"; else WORKER_HOST="npm run dev:worker -w apps/backend"; WORKER_CLUSTER="npm run dev:worker:cluster -w apps/backend"; WORKER_ENGINE="npm run dev:worker:engine -w apps/backend"; fi

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
bash "${ROOT}/scripts/ensure-temporal.sh"
bash "${ROOT}/scripts/ensure-mongo.sh"
bash "${ROOT}/scripts/ensure-headscale.sh"
bash "${ROOT}/scripts/instance/platform-services.sh"

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
if [ "$SPLIT" = true ]; then
  reclaim_port 3002 "Root API"
  reclaim_port 5175 "Root Vite"
fi

# Also terminate any stale worker processes from previous sessions
# Workers do not hot-reload and must start fresh
STALE_WORKERS=$(pgrep -u "$(id -u)" -f "worker-host|worker-cluster|worker-engine" 2>/dev/null || true)
if [ -n "$STALE_WORKERS" ]; then
  echo "  ⚠️  Reclaiming stale Temporal workers (PID: ${STALE_WORKERS})..."
  kill $STALE_WORKERS 2>/dev/null || true
  sleep 0.3
fi

# ── 3. DEV PROCESS ORCHESTRATION ────────────────────────────────────
if [ "$SPLIT" = true ]; then
  echo "▶ [3/3] Starting root and your instance..."
  npm run dev:split:setup -w apps/backend
  SPLIT_ENV="${ROOT}/apps/backend/data/dev-split"
  with_env() { echo "set -a; . '${SPLIT_ENV}/$1.env'; set +a; exec $2"; }
  ROOT_WEB="$(grep '^PUBLIC_URL=' "${SPLIT_ENV}/root.env" | cut -d= -f2-)"
  INSTANCE_WEB="$(grep '^PUBLIC_URL=' "${SPLIT_ENV}/instance.env" | cut -d= -f2-)"
  echo "═══════════════════════════════════════════════════════════════════════"
  echo "  Root:         ${ROOT_WEB}   (sign in here)"
  echo "  Instance:     ${INSTANCE_WEB}"
  echo "  Hub:          $(grep '^PUBLIC_URL=' "${SPLIT_ENV}/hub.env" | cut -d= -f2-)   (shared projects)"
  echo "  APIs:         root :3002, instance :3001, hub :3003"
  echo "═══════════════════════════════════════════════════════════════════════"
  exec npx concurrently --kill-others \
    --names "root,instance,hub,web-root,web-instance,web-hub,worker-host,worker-cluster,worker-engine" \
    --prefix-colors "red,blue,white,gray,cyan,gray,yellow,magenta,green" \
    "bash -c \"$(with_env root 'npm run dev -w apps/backend')\"" \
    "bash -c \"$(with_env instance 'npm run dev -w apps/backend')\"" \
    "bash -c \"$(with_env hub 'npm run dev -w apps/backend')\"" \
    "KOALA_BACKEND=http://localhost:3002 VITE_API_BASE=/api npm run dev -w apps/frontend -- --port 5175 --strictPort" \
    "KOALA_BACKEND=http://localhost:3001 VITE_API_BASE=/api npm run dev -w apps/frontend -- --port 5173 --strictPort" \
    "KOALA_BACKEND=http://localhost:3003 VITE_API_BASE=/api npm run dev -w apps/frontend -- --port 5176 --strictPort" \
    "bash -c \"$(with_env instance 'npm run dev:worker -w apps/backend')\"" \
    "bash -c \"$(with_env instance 'npm run dev:worker:cluster -w apps/backend')\"" \
    "bash -c \"$(with_env instance 'npm run dev:worker:engine -w apps/backend')\""
fi

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
  --names "backend,frontend,worker-host,worker-cluster,worker-engine" \
  --prefix-colors "blue,cyan,yellow,magenta,green" \
  "npm run dev -w apps/backend" \
  "npm run dev -w apps/frontend" \
  "$WORKER_HOST" \
  "$WORKER_CLUSTER" \
  "$WORKER_ENGINE"
