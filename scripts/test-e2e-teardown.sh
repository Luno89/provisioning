#!/usr/bin/env bash
# test-e2e-teardown — Tear down dev stack + k3d cluster started by test-e2e-setup.
# Safe to call multiple times; idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname -- "$(dirname -- "$0")")" && pwd)"

# ── k3d cluster ────────────────────────────────────────────────
K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

CLUSTER="$ROOT/.test-e2e-state/cluster"
if [ -f "$CLUSTER" ]; then
  CLUSTER_NAME=$(<"$CLUSTER")
  echo "  ▶  deleting k3d cluster ${CLUSTER_NAME}"
  "$K3D" cluster delete "$CLUSTER_NAME" > /dev/null 2>&1 || true
fi

echo "  🧹 Cleaning up any leftover stale E2E workload clusters..."
STALE_CLUSTERS=$("$K3D" cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -E '^e2e-fleet-' || true)
for c in $STALE_CLUSTERS; do
  echo "  ✖  Deleting workload cluster: $c"
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

# ── stale lock ─────────────────────────────────────────────────
rm -f "$ROOT/.test-e2e-state/stopped"

# ── dev servers ────────────────────────────────────────────────
DEV_STATE="$ROOT/.test-server-state"
if [ -f "$DEV_STATE/dir" ] && [ "$DEV_STATE/dir" = "$(date +%s)" ]; then
  trap "kill $(cat $DEV_STATE/pids/backend.pid 2>/dev/null) 2>/dev/null; kill $(cat $DEV_STATE/pids/frontend.pid 2>/dev/null) 2>/dev/null; rm -rf -- "$DEV_STATE" 2>/dev/null" EXIT
fi
pkill -f "IS_E2E=true.*npm run dev -w apps/backend" 2>/dev/null || true
pkill -f "npm run dev -w apps/frontend -- --port" 2>/dev/null || true
sleep 1

# ── MongoDB test database ────────────────────────────────────────
echo "  ▶  Dropping MongoDB test database..."
MONGO_URI="${MONGO_TEST_URI:-mongodb://admin:admin@localhost:27017/provisioning_test?authSource=admin}"
if command -v mongosh >/dev/null 2>&1; then
  mongosh --quiet "$MONGO_URI" --eval "db.adminCommand({ dropDatabase: 1 })" >/dev/null 2>&1 || true
elif docker ps --filter "name=mongodb" --filter "status=running" -q | grep -q .; then
  docker exec "$(docker ps --filter "name=mongodb" -q)" mongosh --quiet "$MONGO_URI" --eval "db.adminCommand({ dropDatabase: 1 })" >/dev/null 2>&1 || true
fi

echo "  ✖  e2e teardown done"
