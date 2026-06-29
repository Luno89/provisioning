#!/usr/bin/env bash
# first-time.sh — Builds the worker Docker image and deploys it into the k3d cluster.
#
# This is the new "docker image deployed as part of creating any new cluster".
# It wraps:
#   1. k3d cluster create --agents 1 --wait 1 <cluster-name> (if not running)
#   2. docker build -t deployworker.sh -f Dockerfile.worker . (the new Docker image)
#   3. Deploy the worker image into the k3d cluster (RunnerContainer + ClusterProvision + Connect + env)

set -euo pipefail

WORKER_IMAGE_NAME="deployworker.sh"
WORKER_WORKDIR=/tmp/provisioning-workspace

echo "🚀 Building worker Docker image..."
docker build -t "${WORKER_IMAGE_NAME}" -f Dockerfile.worker .

echo "  ▶  deploying ${WORKER_IMAGE_NAME}..."

# The worker image runs inside a pod in the k3d cluster with:
#   - runnercontainer (no inventory, owned by user)
#   - cluster provision (monitoring + agent stack)
#   - connect (kubeconfig connection)
#   - env pointing to RunnerContainer/deployworkerd.envfile template

# Run the worker entry point
./apps/run-container/workdir/worker-entrypoint.sh
