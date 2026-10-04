#!/usr/bin/env bash
# deploy-worker.sh — Builds the worker Docker image and deploys it into the k3d cluster.
#
# Usage: deploy-worker.sh [cluster-name]
#   cluster-name defaults to "provisioning-lunorica"

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CLUSTER_NAME="${1:-provisioning-lunorica}"
WORKER_IMAGE_NAME="nowrinkles/app:dev"

# Resolve binaries
K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi

if ss -ltnH "( sport = :7233 )" | awk '{print $4}' | grep -q '^127\.0\.0\.1:7233$'; then
  echo "❌ Temporal listens on 127.0.0.1 only, so a worker inside the cluster cannot reach it at host.k3d.internal:7233."
  echo "   Recreate it reachable from the cluster first:  PLATFORM_BIND=0.0.0.0 ./bin/docker-compose -f docker-compose.temporal.yml up -d"
  echo "   That also opens it to your network — do it only on a machine you trust the network of."
  exit 1
fi

if ss -ltnH "( sport = :27017 )" | awk '{print $4}' | grep -q '^127\.0\.0\.1:27017$'; then
  echo "❌ MongoDB listens on 127.0.0.1 only, so a worker inside the cluster cannot reach it at host.k3d.internal:27017."
  echo "   The worker reads large Temporal payloads from it. Recreate it reachable from the cluster first:"
  echo "   PLATFORM_BIND=0.0.0.0 ./bin/docker-compose -f docker-compose.mongo.yml up -d"
  echo "   That also opens it to your network — do it only on a machine you trust the network of."
  exit 1
fi

echo "🚀 Building worker Docker image..."
docker build -t "${WORKER_IMAGE_NAME}" "${ROOT}"

echo "  ▶  importing ${WORKER_IMAGE_NAME} into k3d cluster '${CLUSTER_NAME}'..."
"$K3D" image import "${WORKER_IMAGE_NAME}" -c "${CLUSTER_NAME}"

echo "  ▶  deploying worker to cluster '${CLUSTER_NAME}'..."
"$KUBECTL" apply -f "${ROOT}/k8s/worker-sa.yaml" --context "k3d-${CLUSTER_NAME}" 2>/dev/null || true

# The worker needs the same master key as the backend to build the Temporal PayloadCodec
# (apps/backend/src/lib/temporal-codec.ts) — without it, it cannot decode the encrypted activity
# arguments the client sends. Read from apps/backend/.env, which is the backend's own source for
# it, so the two can never disagree.
#
# `create --dry-run | apply` rather than plain create, so re-running this script after rotating a
# key updates the Secret instead of failing with AlreadyExists.
SECRET_ARGS=()
for KEY_NAME in SESSION_KEY DATA_KEY PAYLOAD_KEY EGRESS_KEY JWT_SECRET; do
  VALUE="$(grep -E "^${KEY_NAME}=" "${ROOT}/apps/backend/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  [ -n "$VALUE" ] && SECRET_ARGS+=(--from-literal="${KEY_NAME}=${VALUE}")
done
MONGO_URI_FROM_ENV="$(grep -E "^MONGO_URI=" "${ROOT}/apps/backend/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MONGO_URI_FROM_ENV="${MONGO_URI_FROM_ENV:-mongodb://admin:${MONGO_ROOT_PASSWORD:-admin}@localhost:27017/provisioning?authSource=admin}"
SECRET_ARGS+=(--from-literal="MONGO_URI=$(printf '%s' "$MONGO_URI_FROM_ENV" | sed -E 's#@(localhost|127\.0\.0\.1):#@host.k3d.internal:#')")
"$KUBECTL" create secret generic provisioning-worker-secrets "${SECRET_ARGS[@]}" \
  --dry-run=client -o yaml --context "k3d-${CLUSTER_NAME}" \
  | "$KUBECTL" apply -f - --context "k3d-${CLUSTER_NAME}" >/dev/null
echo "  ▶  worker keys synced (${#SECRET_ARGS[@]} from apps/backend/.env)"
"$KUBECTL" apply -f "${ROOT}/k8s/worker-deployment.yaml" --context "k3d-${CLUSTER_NAME}"

# Best-effort: the PodMonitor CRD only exists once the Prometheus Operator (part of the cluster's
# monitoring stack, see packages/cdktf-infra/constructs/monitoring.ts) has been installed. On a
# fresh cluster this script can run before that's landed, so a missing CRD here shouldn't fail
# the whole worker deploy — just skip it, same tolerance pattern as worker-sa.yaml above.
"$KUBECTL" apply -f "${ROOT}/k8s/worker-podmonitor.yaml" --context "k3d-${CLUSTER_NAME}" 2>/dev/null || \
  echo "  ⚠️  Skipped worker-podmonitor.yaml (Prometheus Operator CRDs not installed yet — re-run this script after the cluster's monitoring stack is up)"

echo "  ▶  worker deployed successfully"
