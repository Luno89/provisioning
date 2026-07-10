#!/usr/bin/env bash
# ensure-cluster.sh — If the k3d cluster is not already running, start it automatically.
#
# This script is called from `npm run dev` to ensure a k3d cluster exists before
# starting the dev servers.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${ROOT}/.k3d-cluster-state"
CLUSTER_FILE="${STATE_DIR}/cluster"

K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi

# Check if the k3d cluster is already up using the resolved K3D binary
if [ -f "$CLUSTER_FILE" ] && "$K3D" cluster list 2>/dev/null | grep -q "provisioning-lunorica"; then
  CLUSTER="$(cat "$CLUSTER_FILE")"
  echo "  ▶  cluster=${CLUSTER} already running — skipping setup"
else
  # Cluster is not running — start it (cluster.sh create will install k3d if needed)
  "${ROOT}/scripts/cluster.sh" create provisioning-lunorica

  # Save state so `npm run dev` can skip
  mkdir -p "$STATE_DIR"
  echo "provisioning-lunorica" > "$CLUSTER_FILE"
fi

# Cluster is running, setup complete.