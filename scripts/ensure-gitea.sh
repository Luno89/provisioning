#!/usr/bin/env bash
# ensure-gitea.sh — Self-hosted git server + container registry for CI/CD.
#
# Unlike Mongo/Temporal (docker-compose, started *before* any cluster exists, because Mongo
# stores cluster records and Temporal orchestrates cluster creation itself), Gitea has no such
# bootstrapping circularity — it can live *inside* the management cluster it needs anyway. This
# script deploys it via its official Helm chart, matching how every app construct in this
# platform already deploys (Helm Release / raw K8s manifests), instead of adding a third
# docker-compose file. Must run after ensure-cluster.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLUSTER_NAME="provisioning-lunorica"
CONTEXT="k3d-${CLUSTER_NAME}"
NAMESPACE="gitea"
RELEASE="gitea"

HELM="${ROOT}/bin/helm"
if [ ! -f "$HELM" ] || ! "$HELM" version >/dev/null 2>&1; then
  HELM="helm"
fi

KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi

if ! "$KUBECTL" --context "$CONTEXT" get nodes >/dev/null 2>&1; then
  echo "  ❌  Management cluster (${CONTEXT}) not reachable — run ensure-cluster.sh first"
  exit 1
fi

# The admin password stays plaintext on disk (gitignored, mode 600) — same trust level as
# Mongo/Temporal's own hardcoded dev creds in their compose files. The more powerful, longer-
# lived Gitea API token minted from it is AES-256-GCM encrypted at rest instead, by
# GiteaService.ts on first use (needs JWT_SECRET from the backend's own env, not available to
# this shell script without fragile .env parsing).
DATA_DIR="${ROOT}/apps/backend/data"
PASSWORD_FILE="${DATA_DIR}/.gitea-admin-password"
mkdir -p "$DATA_DIR"

if [ ! -s "$PASSWORD_FILE" ]; then
  echo "  ▶  Generating Gitea admin password..."
  openssl rand -base64 24 | tr -d '\n' > "$PASSWORD_FILE"
  chmod 600 "$PASSWORD_FILE"
fi
GITEA_ADMIN_PASSWORD="$(cat "$PASSWORD_FILE")"

echo "  ▶  Ensuring Gitea is installed (helm upgrade --install is a cheap no-op when nothing changed)..."
"$HELM" repo add gitea-charts https://dl.gitea.com/charts/ >/dev/null 2>&1 || true
"$HELM" repo update gitea-charts >/dev/null 2>&1

# postgresql-ha (3-replica quorum) and valkey-cluster (6-node cluster) are this chart's
# defaults — wildly oversized for a single-node management cluster and won't schedule cleanly
# here. Standalone `postgresql` (single pod) gives Gitea a real Postgres instance via the
# chart's own bundled subchart; disabling valkey-cluster with nothing to replace it just lets
# Gitea fall back to its own built-in in-memory cache/queue, which is fine at replicaCount: 1.
"$HELM" upgrade --install "$RELEASE" gitea-charts/gitea \
  --kube-context "$CONTEXT" \
  -n "$NAMESPACE" --create-namespace \
  --set gitea.admin.username=provisioning-bot \
  --set gitea.admin.password="${GITEA_ADMIN_PASSWORD}" \
  --set gitea.admin.email=bot@provisioning.local \
  --set gitea.admin.passwordMode=keepUpdated \
  --set service.http.type=NodePort \
  --set service.http.nodePort=31737 \
  --set service.ssh.type=NodePort \
  --set postgresql.enabled=true \
  --set postgresql-ha.enabled=false \
  --set valkey-cluster.enabled=false \
  --set strategy.type=Recreate \
  --set-string gitea.config.security.ALLOWED_HOST_LIST='private\,loopback' \
  --wait --timeout 5m
  # strategy=Recreate: the chart's default RollingUpdate brings up a second pod (sharing the
  # same ReadWriteOnce PVC) before killing the first — Gitea's local leveldb queue can't be
  # opened by two processes at once, so every config change crash-loops the new pod until the
  # old one is gone. Confirmed live. Recreate kills the old pod first.
  # security.ALLOWED_HOST_LIST: Gitea blocks webhook target URLs on private/loopback IPs by
  # default (SSRF protection) — this platform's backend is only reachable from inside the
  # cluster via the node's private LAN IP, so webhooks need that explicitly allowed. Confirmed
  # live — repo/webhook creation 422'd with "Invalid url" without this.
  # service.http.nodePort=31737: pinned rather than left to Kubernetes' random NodePort
  # allocation, because the node's containerd needs a one-time `/etc/rancher/k3s/registries.yaml`
  # entry (see the README/CLAUDE.md note this script's own comment block points to) naming this
  # exact host:port as an insecure/HTTP-allowed registry — a random port would silently break
  # that config on every reinstall.

echo "  ▶  Waiting for Gitea to be ready..."
"$KUBECTL" --context "$CONTEXT" -n "$NAMESPACE" rollout status deployment/gitea --timeout=120s

# Minimal-RBAC ServiceAccount for Phase 1's ephemeral pipeline build Jobs — applied here since
# this script already owns "things pipelines need in-cluster" alongside Gitea itself. No
# RoleBinding, no K8s API access at all — only network egress to Gitea's registry.
"$KUBECTL" --context "$CONTEXT" apply -f "${ROOT}/k8s/pipeline-build-sa.yaml"

echo "  ✅  Gitea ready (namespace: ${NAMESPACE})"
