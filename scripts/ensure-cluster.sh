#!/usr/bin/env bash
# ensure-cluster.sh — If the k3d cluster is not already running, start it automatically.
#
# This script is called from `npm run dev` to ensure a k3d cluster exists before
# starting the dev servers.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${ROOT}/.k3d-cluster-state"
CLUSTER_FILE="${STATE_DIR}/cluster"

# Check if the k3d cluster is already up
if [ -f "$CLUSTER_FILE" ] && k3d cluster list 2>/dev/null | grep -q "provisioning-lunorica"; then
  CLUSTER="$(cat "$CLUSTER_FILE")"
  echo "  ▶  cluster=${CLUSTER} already running — skipping setup"
  exit 0
fi

# Cluster is not running — start it (cluster.sh create will install k3d if needed)
  "${ROOT}/scripts/cluster.sh" create provisioning-lunorica

  # Save state so `npm run dev` can skip
  mkdir -p "$STATE_DIR"
  echo "provisioning-lunorica" > "$CLUSTER_FILE"