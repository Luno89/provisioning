#!/usr/bin/env bash
# deploy-worker.sh — Builds the worker Docker image and deploys it into the k3d cluster.
#
# Usage: deploy-worker.sh [cluster-name]
#   cluster-name defaults to "provisioning-lunorica"

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CLUSTER_NAME="${1:-provisioning-lunorica}"
WORKER_IMAGE_NAME="deployworker.sh"

# Resolve binaries
K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi

echo "🚀 Building worker Docker image..."
docker build -t "${WORKER_IMAGE_NAME}" -f Dockerfile.worker .

echo "  ▶  importing ${WORKER_IMAGE_NAME} into k3d cluster '${CLUSTER_NAME}'..."
"$K3D" image import "${WORKER_IMAGE_NAME}" -c "${CLUSTER_NAME}"

echo "  ▶  deploying worker to cluster '${CLUSTER_NAME}'..."
"$KUBECTL" apply -f "${ROOT}/k8s/worker-sa.yaml" --context "k3d-${CLUSTER_NAME}" 2>/dev/null || true
"$KUBECTL" apply -f "${ROOT}/k8s/worker-deployment.yaml" --context "k3d-${CLUSTER_NAME}"

# Best-effort: the PodMonitor CRD only exists once the Prometheus Operator (part of the cluster's
# monitoring stack, see packages/cdktf-infra/constructs/monitoring.ts) has been installed. On a
# fresh cluster this script can run before that's landed, so a missing CRD here shouldn't fail
# the whole worker deploy — just skip it, same tolerance pattern as worker-sa.yaml above.
"$KUBECTL" apply -f "${ROOT}/k8s/worker-podmonitor.yaml" --context "k3d-${CLUSTER_NAME}" 2>/dev/null || \
  echo "  ⚠️  Skipped worker-podmonitor.yaml (Prometheus Operator CRDs not installed yet — re-run this script after the cluster's monitoring stack is up)"

echo "  ▶  worker deployed successfully"
