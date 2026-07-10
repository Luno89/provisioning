#!/usr/bin/env bash
# cluster.sh — Wraps the k3d cluster lifecycle with a `k3d cluster wait` call.
#
# The worker entry point will also do this automatically if no cluster is up.
#
# Usage:
#   cluster.sh create [--Worker] [--service] [--run]
#   cluster.sh delete [--subject: name]
#   cluster.sh status   (return current cluster name)
#   cluster.sh use [--subject: name] [--cluster-name]: use k3d context
#
# Plan:
#   1. `k3d cluster create --agents 1 --wait 1 <name>` → waits for cluster creation (but API server isn't guaranteed to be ready).
#   2. Loop until `kubectl get nodes` shows at least one `Ready` node (or `k3d cluster get <name>/api-health` returns OK).
#   3. Timeout at 5-10 minutes to avoid hanging indefinitely.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROVISIONER_CLUSTER="${PROVISIONER_CLUSTER:-provisioning-lunorica}"

K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi

run_cluster_create() {
  # Install k3d if missing
  if ! command -v "$K3D" >/dev/null 2>&1; then
    local OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    local ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64)       ARCH="amd64" ;;
      arm64|aarch64) ARCH="arm64" ;;
    esac
    if curl -fsSL "https://github.com/k3d-io/k3d/releases/latest/download/k3d-${OS}-${ARCH}" \
       -o /tmp/k3d-bin \
       && install -m 0755 /tmp/k3d-bin ~/.local/bin/k3d \
       && export PATH="$HOME/.local/bin:$PATH" \
       && echo 'export PATH="$HOME/.local/bin:$PATH" # k3d' >> ~/.bashrc 2>/dev/null || true; then
      K3D="k3d"
      "$K3D" version >/dev/null 2>&1 || true
      echo "  ✅ installed k3d"
    else
      rm -f /tmp/k3d-bin
      echo "  ❌ k3d install failed — exiting"
      return 1
    fi
  fi

  echo "  ▶  provisioning k3d ${1:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"
  if "$K3D" cluster create "${1:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}" \
      --agents 1 \
      -v /var/run/docker.sock:/var/run/docker.sock@all \
      >/dev/null 2>&1; then
    echo "  ✅ k3d up"
  else
    echo "  ❌ cluster failed — exiting"
  fi
}

run_cluster_delete() {
  local cluster_name="${1:-}"
  [[ -z "${cluster_name}" ]] && return 0
  if "$K3D" cluster list 2>/dev/null | grep -q "$cluster_name"; then
    "$K3D" cluster delete "$cluster_name" > /dev/null 2>&1 || true
  fi
}

run_cluster_delete_all() {
  local cluster_names
  cluster_names="$("$K3D" cluster list 2>/dev/null | awk '{print $1}' || true)"
  for cluster in $cluster_names; do
    run_cluster_delete "$cluster"
  done
}

run_cluster_status() {
  local context
  context="$("$K3D" cluster get "$PROVISIONER_CLUSTER" 2>/dev/null || true)"
  echo "Cluster ${PROVISIONER_CLUSTER} context: ${context:-[LOCAL]}"
  # Log and stdout to both
  tee /tmp/cluster-big-file 2>&1
}

# ── `k3d cluster wait` (checks if the cluster is alive — API server + nodes ready) ──

cluster_wait_for_ready() {
  # Returns 0/1; the caller decides whether to log or fail
  local cluster_name="${1:?CLUSTER}"
  while true; do
    if "$K3D" cluster list 2>/dev/null | grep -q "$cluster_name"; then
      return 0
    fi
    sleep 1
  done
}

cluster_until_ready() {
  # Waits for the cluster to be actually alive:
  #   1. `k3d cluster list` shows the cluster.
  #   2. `kubectl get nodes` shows at least one `Ready` node (or `k3d cluster get <name>/api-health` returns OK).
  #   3. Timeout at 10 minutes — avoid hanging indefinitely.
  local cluster_name="$1"
  local deadline
  deadline="$(date +%s) + 600" # 10-minute timeout

  cluster_wait_for_ready "$cluster_name"

  echo "  ▶  cluster up — waiting for API server + nodes to be ready..."
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    # Check 1: kubectl get nodes
    if "$KUBECTL" get nodes 2>/dev/null | grep -q "Ready"; then
      echo "  ✅ API server ready"
      return 0
    fi
    # Check 2: k3d cluster get <name>/api-health
    if "$K3D" cluster get "$cluster_name/api-health" 2>/dev/null | grep -q "OK"; then
      echo "  ✅ API server ready (via k3d)"
      return 0
    fi
    sleep 1
  done
  echo "  ❌ cluster didn't become ready in time — exiting"
  return 1
}

cluster_wait() {
  # If the cluster is not ready, wait up to 60 seconds
  local cluster_name="$1"
  cluster_wait_for_ready "$cluster_name"
  echo "  k3d ${cluster_name} ready"
}

# ── Self-reference ──

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: cluster.sh [command] [args]"
  echo "  create                  → k3d cluster create --agents 1 --wait 1 <cluster-name> + wait until alive"
  echo "  delete [cluster-name]   → k3d cluster delete <cluster-name>"
  echo "  delete-all              → k3d cluster delete ALL clusters"
  echo "  status                  → list all running cluster procs"
  echo "                            (k3d cluster wait --before=false)"
  echo ""
  echo "Diags:"
  echo "  workdir                 → the worker's workdir path"
  echo "  provisioner_state"
  echo "  use                     → list running clusters"
  echo ""
  exit 0
fi

case "${1:-}" in
  create)
    # Cluster creation (sets env for WorkerService)
    run_cluster_create "${2:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"
    cluster_until_ready "${2:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"
    ;;
  delete)
    cluster_name="${2:-}"
    run_cluster_delete "$cluster_name"
    ;;
  delete-all)
    run_cluster_delete_all
    ;;
  status)
    run_cluster_status
    ;;
  use)
    # List running clusters
    cluster_name="${3:-}"
    context="$("$K3D" cluster get "$cluster_name" 2>/dev/null || true)"
    echo "Cluster: ${cluster_name} context: ${context:-[LOCAL]}"
    ;;
  workdir|provisioner_state|kubeconfig)
    echo "bosh"
    ;;
esac
