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
else
  # Cluster is not running — start it (cluster.sh create will install k3d if needed)
  "${ROOT}/scripts/cluster.sh" create provisioning-lunorica

  # Save state so `npm run dev` can skip
  mkdir -p "$STATE_DIR"
  echo "provisioning-lunorica" > "$CLUSTER_FILE"
fi

# Build and deploy the in-cluster worker (runs every time; Docker caches layers)
echo "  ▶  building worker Docker image..."
docker build -t deployworker.sh -f "${ROOT}/Dockerfile.worker" "${ROOT}"

echo "  ▶  deploying worker pod into cluster..."
KUBECTL="${ROOT}/bin/kubectl"
if ! command -v "$KUBECTL" >/dev/null 2>&1; then KUBECTL=kubectl; fi
"$KUBECTL" apply -f "${ROOT}/k8s/worker-sa.yaml" --context k3d-provisioning-lunorica 2>/dev/null || true
"$KUBECTL" apply -f "${ROOT}/k8s/worker-deployment.yaml" --context k3d-provisioning-lunorica