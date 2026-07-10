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

echo "🚀 Starting Temporal.io server..."
DOCKER_COMPOSE="${ROOT}/bin/docker-compose"
if [ ! -f "$DOCKER_COMPOSE" ] || ! "$DOCKER_COMPOSE" version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  elif docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  else
    # Download docker-compose locally
    echo "📥 Downloading docker-compose..."
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64)        ARCH="x86_64" ;;
      arm64|aarch64) ARCH="aarch64" ;;
    esac
    mkdir -p "${ROOT}/bin"
    if curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.1/docker-compose-${OS}-${ARCH}" -o "${ROOT}/bin/docker-compose" \
       && chmod +x "${ROOT}/bin/docker-compose"; then
      DOCKER_COMPOSE="${ROOT}/bin/docker-compose"
      echo "  ✅ Installed docker-compose"
    else
      echo "❌ Error: Failed to download docker-compose. Temporal.io cannot be started."
      exit 1
    fi
  fi
fi

# Run docker-compose
if [ -n "$DOCKER_COMPOSE" ]; then
  $DOCKER_COMPOSE -f "${ROOT}/docker-compose.temporal.yml" up -d
else
  echo "❌ Error: docker-compose not found. Cannot start Temporal.io server."
  exit 1
fi

echo "🚀 Building worker Docker image..."
docker build -t "${WORKER_IMAGE_NAME}" -f Dockerfile.worker .

echo "  ▶  importing ${WORKER_IMAGE_NAME} into k3d..."
K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi
"$K3D" image import "${WORKER_IMAGE_NAME}" -c provisioning-lunorica

echo "  ▶  deploying ${WORKER_IMAGE_NAME}..."

# Deploy the worker pod via K8s manifests (replaces old run-container entrypoint)
KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi
"$KUBECTL" apply -f "${ROOT}/k8s/worker-sa.yaml" --context k3d-provisioning-lunorica 2>/dev/null || true
"$KUBECTL" apply -f "${ROOT}/k8s/worker-deployment.yaml" --context k3d-provisioning-lunorica
