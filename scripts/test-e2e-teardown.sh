#!/usr/bin/env bash
# test-e2e-teardown — Tear down dev stack + k3d cluster started by test-e2e-setup.
# Safe to call multiple times; idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname -- "$(dirname -- "$0")")" && pwd)"

# ── k3d cluster ────────────────────────────────────────────────
CLUSTER="$ROOT/.test-e2e-state/cluster"
if [ -f "$CLUSTER" ]; then
  CLUSTER_NAME=$(<"$CLUSTER")
  echo "  ▶  deleting k3d cluster ${CLUSTER_NAME}"
  k3d cluster delete "$CLUSTER_NAME" > /dev/null 2>&1 || true
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

echo "  ✖  e2e teardown done"
