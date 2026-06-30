#!/usr/bin/env bash
# first-time.sh — Builds the worker Docker image and deploys it into the k3d cluster.
#
# This is the new "docker image deployed as part of creating any new cluster".
# It wraps:
#   1. k3d cluster create --agents 1 --wait 1 <cluster-name> (if not running)
#   2. docker build -t deployworker.sh -f Dockerfile.worker . (the new Docker image)
#   3. Deploy the worker image into the k3d cluster (RunnerContainer + ClusterProvision + Connect + env)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_IMAGE_NAME="deployworker.sh"
WORKER_WORKDIR=/tmp/provisioning-workspace

echo "🚀 Building worker Docker image..."
docker build -t "${WORKER_IMAGE_NAME}" -f Dockerfile.worker .

echo "  ▶  deploying ${WORKER_IMAGE_NAME}..."

# Deploy the worker pod via K8s manifests (replaces old run-container entrypoint)
KUBECTL="${ROOT}/bin/kubectl"
if ! command -v "$KUBECTL" >/dev/null 2>&1; then KUBECTL=kubectl; fi
"$KUBECTL" apply -f "${ROOT}/k8s/worker-sa.yaml" --context k3d-provisioning-lunorica 2>/dev/null || true
"$KUBECTL" apply -f "${ROOT}/k8s/worker-deployment.yaml" --context k3d-provisioning-lunorica
