#!/usr/bin/env bash
# test-e2e-setup — Provisions a k3d cluster and starts the dev stack for e2e tests.
# Called by:  npm run test:e2e:sync  (unit preflight + set up + run playwright)
#            npm run test:e2e        (skip unit, just set up + run playwright)
set -euo pipefail

ROOT="$(cd "$(dirname -- "$(dirname -- "$0")")" && pwd)"

# ── 1. Stop conflicting local cluster ─────────────────────────
mkdir -p "$ROOT/.test-e2e-state"
K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

echo "  🧹 Cleaning up any leftover stale E2E clusters..."
STALE_CLUSTERS=$("$K3D" cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -E '^e2e-fleet-' || true)
for c in $STALE_CLUSTERS; do
  echo "  ✖  Deleting stale cluster: $c"
  "$K3D" cluster delete "$c" >/dev/null 2>&1 || true
done
# Purge any remaining orphaned containers/volumes that K3d fails to list
STALE_CONTS=$(docker ps -a --filter "name=k3d-e2e-fleet-" -q)
if [ -n "$STALE_CONTS" ]; then
  docker rm -f $STALE_CONTS >/dev/null 2>&1 || true
fi
STALE_VOLS=$(docker volume ls --filter "name=k3d-e2e-fleet-" -q)
if [ -n "$STALE_VOLS" ]; then
  docker volume rm $STALE_VOLS >/dev/null 2>&1 || true
fi

# Resolve docker-compose binary
DOCKER_COMPOSE="docker-compose"
if ! command -v docker-compose >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif [ -f "$ROOT/bin/docker-compose" ]; then
    DOCKER_COMPOSE="$ROOT/bin/docker-compose"
  fi
fi

echo "  🧹 Resetting local Temporal server to clear stale workflows..."
$DOCKER_COMPOSE -f "$ROOT/docker-compose.temporal.yml" down -v >/dev/null 2>&1 || true
$DOCKER_COMPOSE -f "$ROOT/docker-compose.temporal.yml" up -d >/dev/null 2>&1 || true
sleep 3

STOPped="$ROOT/.test-e2e-state/stopped"
if [ -f "$STOPped" ]; then
  echo "  ⚠️  k3d-Lunorica-local-server-0 already stopped"
else
  pkill -f "k3d-Lunorica-local-server-0" 2>/dev/null || true
  sleep 1
  docker inspect k3d-Lunorica-local-server-0 2>/dev/null && \
    docker stop k3d-Lunorica-local-server-0 2>/dev/null 1>/dev/null || true || true
  sleep 1
  date +%s > "$STOPped"
  echo "  ⚠️  k3d-Lunorica-local-server-0 stopped"
fi

# ── 2. Start k3d cluster ─────────────────────────────────────
if ! docker ps >/dev/null 2>&1; then
  echo "  ▶  docker unavailable, skipping k3d"
else
  K3D="${ROOT}/bin/k3d"
  if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
    K3D="k3d"
  fi
  CLUSTER="e2e-fleet-$(($(date +%s%N) % 10000))"
  echo "  ▶  provisioning k3d ${CLUSTER}"
  if docker ps 2>/dev/null | grep -q "K8S"; then
    echo "  ✅  k8s present in docker ps — skipping k3d (managed by infra)"
  elif docker run -d --name k3d-nginx -p 80:80 -p 443:443 -t alpine nginx > /dev/null 2>&1; then
    if ! "$K3D" cluster create --agents 1 --wait 1 -v /var/run/docker.sock:/var/run/docker.sock@all "$CLUSTER" > /dev/null 2>&1; then
      echo "  ⚠️  k3d failed — exiting (will be skipped)"
    else
      echo "  ✅  k3d ${CLUSTER} ready"
      echo "$CLUSTER" > "$ROOT/.test-e2e-state/cluster"
    fi
    docker rm -f k3d-nginx 2>/dev/null || true
  fi
fi

# ── 3. Start dev stack (handled by Playwright webServer config) ──


echo "  ✅  e2e-setup complete"
