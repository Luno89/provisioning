#!/usr/bin/env bash
# verify-cluster.sh — Health-check a freshly provisioned cluster.
# Validates:
#   1. Backend is listening on :3001
#   2. Cluster row exists in DB and has status "healthy"
#   3. API server is responding inside the k3d server container
#   4. Local-path StorageClass allows volume expansion
#   5. CoreDNS is patched with real nameservers
#   6. Monitoring stack (helm release `prometheus`) is deployed
#   7. Traefik stack (helm release `traefik`) is deployed
#
# Usage:  verify-cluster.sh <cluster-name> [--debug]
#
# Exits:
#   0 — healthy
#   1 — failed one or more checks

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-3001}"
CLUSTER_NAME=""

DEBUG_FLAG=false
[[ "${3:-}" == "--debug" ]] && DEBUG_FLAG=true

[[ $# -lt 1 ]] && { echo "Usage: $0 <cluster-name> [--debug]"; exit 1; }
CLUSTER_NAME="$1"

pass()  { [[ -n "${1:-}" ]] && echo "  ✅$1" || echo "  ✅ passed"; }
fail()  { [[ -n "${1:-}" ]] && echo "  ❌$1" || echo "  ❌ failed"; }
warn()  { local msg="${1:-}"; [[ "$msg" == "{END}" ]] && exit 1 && return 0; [[ -n "$msg" ]] && echo "  ⚠  $msg" || echo "  ⚠  warning"; }

# ── MAIN ──────────────────────────────────────────────────────────────

echo "────────────────────────────────────"
echo "▶ cluster=${CLUSTER_NAME}"
echo "────────────────────────────────────"

FAILED=0

# 1. Backend listening?
if ! ss -tln 2>/dev/null | grep -q ":${BACKEND_PORT} "; then
  fail "Backend not listening on :${BACKEND_PORT}"
  FAILED=$((FAILED+1))
fi

# 2. Cluster database state
CLUSTER_DB="$ROOT/apps/backend/data/clusters.json"
if [[ -f "$CLUSTER_DB" ]]; then
  RUNNING="$(jq -r --arg n "$CLUSTER_NAME" '[.[] | select(.name == $n)] | .[0].status  // empty' "$CLUSTER_DB")"
else
  RUNNING=""
fi

if [[ -z "$RUNNING" ]]; then
  fail "Cluster '${CLUSTER_NAME}' not in clusters.json"
  FAILED=$((FAILED+1))
elif [[ "$RUNNING" == "healthy" ]]; then
  pass "Cluster status: healthy"
elif [[ "$RUNNING" == "destroyed" ]]; then
  fail "Cluster status: destroyed"
  FAILED=$((FAILED+1))
else
  warn "Cluster status: $RUNNING (not yet healthy)"
fi

# 3. k3d API server reachable (inside k3d server container)
K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi
API_REDIRECT="$("$K3D" cluster get "${CLUSTER_NAME}/api-health" 2>&1)" || true
if echo "$API_REDIRECT" | grep -qi "ok\|200\|cluster federated"; then
  pass "k3d ${CLUSTER_NAME} //api-health returned OK"
else
  fail "k3d ${CLUSTER_NAME} //api-health returned: ${API_REDIRECT}"
  FAILED=$((FAILED+1))
fi

# 4. Local-path StorageClass observed via kubectl
if [[ -f "/tmp/kubeconfig-${CLUSTER_NAME}" ]]; then
  SC_EXPAND="$(docker exec k3d-${CLUSTER_NAME}-server-0 kubectl get storageclass local-path -o jsonpath='{.allowVolumeExpansion}' 2>&1)"
  if [[ "$SC_EXPAND" == "true" ]]; then
    pass "StorageClass local-path allowVolumeExpansion=true"
  else
    fail "StorageClass local-path: allowVolumeExpansion=$SC_EXPAND"
    FAILED=$((FAILED+1))
  fi
  emdls="$(docker exec k3d-${CLUSTER_NAME}-server-0 kubectl get storageclass -o jsonpath='{.items[0].metadata.name}' 2>&1)"

  if [[ -n "$SC_EXPAND" ]]; then
    pass "StorageClass ${SC_EXPAND} exists"
  else
    fail "StorageClass check failed"
    FAILED=$((FAILED+1))
  fi
fi

# 5. CoreDNS patched with real nameservers
CM_OUTPUT="$(docker exec k3d-${CLUSTER_NAME}-server-0 kubectl get configmap coredns -n kube-system -o json 2>&1)"
if echo "$CM_OUTPUT" | jq -e '.data.Corefile | test("8\\.[0-9]+\\.[0-9]+\\.[0-9]+")' >/dev/null 2>&1; then
  NAMESERVERS="$(docker exec k3d-${CLUSTER_NAME}-server-0 kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}' 2>&1)"
  pass "CoreDNS forward targets: $NAMESERVERS"
else
  fail "CoreDNS ConfigMap has no valid nameservers (k3s-determined false positive)"
  FAILED=$((FAILED+1))
fi

# 6. Monitoring stack (prometheus Helm release)
HELM_OUTPUT="$(docker exec k3d-${CLUSTER_NAME}-server-0 helm list -A 2>/dev/null || true)"
if echo "$HELM_OUTPUT" | grep -q "^[0-9]"; then
  if echo "$HELM_OUTPUT" | grep -qi "prometheus"; then
    pass "Helm release `prometheus` deployed"
  else
    fail "Helm release `prometheus` NOT found in cluster"
    FAILED=$((FAILED+1))
  fi
  if echo "$HELM_OUTPUT" | grep -qi "traefik"; then
    pass "Helm release `traefik` deployed"
  else
    fail "Helm release `traefik` NOT found in cluster"
    FAILED=$((FAILED+1))
  fi
else
  fail "helm list inside k3d did not return data"
  FAILED=$((FAILED+1))
fi

# 7. Pods / nodes
NODES="$(docker exec k3d-${CLUSTER_NAME}-server-0 kubectl get nodes 2>&1 || true)"
if echo "$NODES" | grep -q "Ready"; then
  READY_COUNT="$(echo "$NODES" | grep -c "Ready" || true)"
  pass "k3s nodes ready (${READY_COUNT}/total)"
else
  fail "No Ready nodes"
  FAILED=$((FAILED+1))
fi

echo ""
if [[ "$FAILED" -gt 0 ]]; then
  echo "═══ CLI FAIL: ${FAILED} checks failed ═══"
  warn
  exit 1
fi

echo "═══ ✅ All checks passed ═══"
exit 0
