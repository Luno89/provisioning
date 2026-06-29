#!/usr/bin/env bash
# test-e2e-setup — Provisions a k3d cluster and starts the dev stack for e2e tests.
# Called by:  npm run test:e2e:sync  (unit preflight + set up + run playwright)
#            npm run test:e2e        (skip unit, just set up + run playwright)
set -euo pipefail

ROOT="$(cd "$(dirname -- "$(dirname -- "$0")")" && pwd)"

# ── 1. Stop conflicting local cluster ─────────────────────────
STOPped="$ROOT/.test-e2e-state/stopped"
if [ -f "$STOPped" ] && [ -n "$(date +%s)" ]; then
  echo "  ⚠️  k3d-Lunorica-local-server-0 already stopped"
  exit 0
fi
pkill -f "k3d-Lunorica-local-server-0" 2>/dev/null || true
sleep 1
docker inspect k3d-Lunorica-local-server-0 2>/dev/null && \
  docker stop k3d-Lunorica-local-server-0 2>/dev/null 1>/dev/null || true || true
sleep 1
date +%s > "$STOPped"
echo "  ⚠️  k3d-Lunorica-local-server-0 stopped"

# ── 2. Start k3d cluster ─────────────────────────────────────
if ! docker ps 2>/dev/null | grep -q "K8S"; then
  echo "  ▶  docker unavailable, skipping k3d"
else
  CLUSTER="e2e-fleet-$(($(date +%s%N) % 10000))"
  echo "  ▶  provisioning k3d ${CLUSTER}"
  if docker ps 2>/dev/null | grep -q "K8S"; then
    echo "  ✅  k8s present in docker ps — skipping k3d (managed by infra)"
  elif docker run -d --name k3d-nginx -p 80:80 -p 443:443 -t alpine nginx > /dev/null 2>&1; then
    npm install -g k3d 2>/dev/null || true
    if ! k3d cluster create --agents 1 --wait 1 "$CLUSTER" > /dev/null 2>&1; then
      echo "  ⚠️  k3d failed — exiting (will be skipped)"
    else
      echo "  ✅  k3d ${CLUSTER} ready"
      echo "$CLUSTER" > "$ROOT/.test-e2e-state/cluster"
    fi
    docker rm -f k3d-nginx 2>/dev/null || true
  fi
fi

# ── 3. Start dev stack (back:3002 / front:5174) ───────────────
DEV_STATE="$ROOT/.test-server-state"
mkdir -p "$DEV_STATE"
if [ -f "$DEV_STATE/dir" ] && [ "$DEV_STATE/dir" = "$(date +%s)" ]; then
  echo "  ▶  dev stack already running"
else
  {
    PORT=3002 IS_E2E=true NODE_ENV=test npm run dev -w apps/backend \
      > "$DEV_STATE/logs/backend.log" 2>&1 &
    BP=$!
    echo "$BP" > "$DEV_STATE/pids/backend.pid"

    VITE_API_BASE=http://localhost:3002/api \
    VITE_SOCKET_URL=http://localhost:3002 \
    npm run dev -w apps/frontend -- --port 5174 \
      > "$DEV_STATE/logs/frontend.log" 2>&1 &
    FP=$!
    echo "$FP" > "$DEV_STATE/pids/frontend.pid"

    sleep 10
    date +%s > "$DEV_STATE/dir"
    echo "  ✅  backend pid=$BP frontend pid=$FP"

    trap 'kill $BP 2>/dev/null; kill $FP 2>/dev/null; rm -rf -- "$DEV_STATE" 2>/dev/null' EXIT EXIT
    # reap
    wait "$FP" 2>/dev/null || true
    wait "$BP" 2>/dev/null || true
  } &
  DEV_PID=$!
  echo "$DEV_PID" > "$DEV_STATE/dev.pid"
fi

echo "  ✅  e2e-setup complete"
