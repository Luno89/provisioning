#!/usr/bin/env bash
# ensure-infisical.sh — Self-hosted secret manager + token vault for platform & pods.
#
# Like Gitea, Infisical runs inside the management cluster (namespace `infisical`, release
# `infisical`). It deploys via its official Helm chart (infisical-standalone + secrets-operator)
# with a pinned NodePort on 31738, single-replica Postgres and Redis subcharts for minimal RAM,
# and persists its encryption keys under apps/backend/data/ (mode 600, gitignored).
# Must run after ensure-cluster.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLUSTER_NAME="provisioning-lunorica"
CONTEXT="k3d-${CLUSTER_NAME}"
NAMESPACE="infisical"
RELEASE="infisical"
OPERATOR_RELEASE="infisical-operator"

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

DATA_DIR="${ROOT}/apps/backend/data"
mkdir -p "$DATA_DIR"

ENCRYPTION_KEY_FILE="${DATA_DIR}/.infisical-encryption-key"
AUTH_SECRET_FILE="${DATA_DIR}/.infisical-auth-secret"
ADMIN_PASSWORD_FILE="${DATA_DIR}/.infisical-admin-password"

if [ ! -s "$ENCRYPTION_KEY_FILE" ]; then
  echo "  ▶  Generating Infisical encryption key (32 hex characters)..."
  openssl rand -hex 16 > "$ENCRYPTION_KEY_FILE"
  chmod 600 "$ENCRYPTION_KEY_FILE"
fi
INFISICAL_ENCRYPTION_KEY="$(cat "$ENCRYPTION_KEY_FILE" | tr -d '\n')"

if [ ! -s "$AUTH_SECRET_FILE" ]; then
  echo "  ▶  Generating Infisical auth secret..."
  openssl rand -base64 32 | tr -d '\n' > "$AUTH_SECRET_FILE"
  chmod 600 "$AUTH_SECRET_FILE"
fi
INFISICAL_AUTH_SECRET="$(cat "$AUTH_SECRET_FILE" | tr -d '\n')"

if [ ! -s "$ADMIN_PASSWORD_FILE" ]; then
  echo "  ▶  Generating Infisical admin password..."
  openssl rand -base64 24 | tr -d '\n' > "$ADMIN_PASSWORD_FILE"
  chmod 600 "$ADMIN_PASSWORD_FILE"
fi
INFISICAL_ADMIN_PASSWORD="$(cat "$ADMIN_PASSWORD_FILE" | tr -d '\n')"

echo "  ▶  Ensuring Infisical Helm charts are updated..."
"$HELM" repo add infisical-helm-charts https://dl.cloudsmith.io/public/infisical/helm-charts/helm/charts/ >/dev/null 2>&1 || true
"$HELM" repo update infisical-helm-charts >/dev/null 2>&1 || true

echo "  ▶  Ensuring infisical-secrets secret exists..."
"$KUBECTL" --context "$CONTEXT" -n "$NAMESPACE" create secret generic infisical-secrets \
  --from-literal=ENCRYPTION_KEY="${INFISICAL_ENCRYPTION_KEY}" \
  --from-literal=AUTH_SECRET="${INFISICAL_AUTH_SECRET}" \
  --from-literal=ADMIN_PASSWORD="${INFISICAL_ADMIN_PASSWORD}" \
  --dry-run=client -o yaml | "$KUBECTL" --context "$CONTEXT" apply -f -

# ── Preflight: an orphaned ingress-nginx admission webhook blocks EVERY Ingress ──
#
# This chart bundles ingress-nginx. If a previous install timed out before its admission-patch Job
# populated the webhook's caBundle, the webhook is left with an EMPTY caBundle, failurePolicy=Fail
# and cluster scope — so every Ingress CREATE/UPDATE on the cluster fails with
# "x509: certificate signed by unknown authority". Measured: it silently blocked every new app
# deploy on this platform for 21 hours. Refuse to compound it.
WEBHOOK="infisical-ingress-nginx-admission"
if "$KUBECTL" --context "$CONTEXT" get validatingwebhookconfiguration "$WEBHOOK" >/dev/null 2>&1; then
  CA="$("$KUBECTL" --context "$CONTEXT" get validatingwebhookconfiguration "$WEBHOOK" \
    -o jsonpath='{.webhooks[0].clientConfig.caBundle}' 2>/dev/null || true)"
  if [ -z "$CA" ]; then
    echo "  ❌  Found ${WEBHOOK} with an EMPTY caBundle."
    echo "      While this exists, every new Ingress on the cluster is rejected and no app can deploy."
    echo "      Remove it, then re-run:"
    echo "        kubectl delete validatingwebhookconfiguration ${WEBHOOK}"
    exit 1
  fi
fi

echo "  ▶  Deploying Infisical Standalone (helm upgrade --install is a cheap no-op when nothing changed)..."
"$HELM" upgrade --install "$RELEASE" infisical-helm-charts/infisical-standalone \
  --kube-context "$CONTEXT" \
  -n "$NAMESPACE" --create-namespace \
  --set replicaCount=1 \
  --set strategy.type=Recreate \
  --set backendEnvironmentVariables.ENCRYPTION_KEY="${INFISICAL_ENCRYPTION_KEY}" \
  --set backendEnvironmentVariables.AUTH_SECRET="${INFISICAL_AUTH_SECRET}" \
  --set backendEnvironmentVariables.ADMIN_PASSWORD="${INFISICAL_ADMIN_PASSWORD}" \
  --set service.type=NodePort \
  --set service.nodePort=31738 \
  --set postgresql.enabled=true \
  --set redis.enabled=true \
  --set redis.cluster.enabled=false \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=256Mi \
  --set resources.limits.memory=512Mi \
  --set ingress.enabled=false \
  --set ingress-nginx.enabled=false \
  --wait --timeout 5m || {
    echo "  ❌  Infisical standalone helm deploy failed or timed out."
    echo "      NOT continuing: a partial install of this chart has already left a cluster-wide"
    echo "      admission webhook behind once, with an empty caBundle and failurePolicy=Fail,"
    echo "      which rejected EVERY new Ingress on the cluster and blocked all app deploys."
    echo "      Fix the install or run scripts/ensure-infisical.sh --purge, then retry."
    exit 1
  }

echo "  ▶  Deploying Infisical Secrets Operator..."
"$HELM" upgrade --install "$OPERATOR_RELEASE" infisical-helm-charts/secrets-operator \
  --kube-context "$CONTEXT" \
  -n "$NAMESPACE" --create-namespace \
  --wait --timeout 3m || {
    echo "  ❌  Infisical secrets operator helm deploy failed or timed out."
    exit 1
  }

echo "  ✅  Infisical ready (namespace: ${NAMESPACE}, nodePort: 31738)"
