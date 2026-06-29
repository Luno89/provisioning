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

PROVISIONER_CLUSTER="${PROVISIONER_CLUSTER:-provisioning-lunorica}"

  run_cluster_create() {
    # Install k3d if missing
    if ! command -v k3d >/dev/null 2>&1; then
      if curl -fsSL https://github.com/k3d-io/k3d/releases/latest/download/k3d-linux-amd64 \
         -o /tmp/k3d-linux-amd64 \
         && install -m 0755 /tmp/k3d-linux-amd64 ~/.local/bin/k3d \
         && echo 'export PATH="$HOME/.local/bin:$PATH" # k3d' >> ~/.bashrc 2>/dev/null || true; then
        k3d version >/dev/null 2>&1 || true
        echo "  ✅ installed k3d"
      else
        rm -f /tmp/k3d-linux-amd64
        echo "  ❌ k3d install failed — exiting"
        return 1
      fi
    fi

    echo "  ▶  provisioning k3d ${1:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"
    if k3d cluster create "${1:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}" >/dev/null 2>&1; then
      echo "  ✅ k3d up"
    else
      echo "  ❌ cluster failed — exiting"
    fi
  }

run_cluster_delete() {
  local cluster_name="${1:-}"
  [[ -z "${cluster_name}" ]] && return 0
  if k3d cluster list 2>/dev/null | grep -q "$cluster_name"; then
    k3d cluster delete "$cluster_name" > /dev/null 2>&1 || true
  fi
}

run_cluster_delete_all() {
  local cluster_names
  cluster_names="$(k3d cluster list 2>/dev/null | awk '{print $1}' || true)"
  for cluster in $cluster_names; do
    run_cluster_delete "$cluster"
  done
}

run_cluster_status() {
  local cluster_name="$(echo "$cluster_id" | sed 's/-[0-9]*-.*//' | tr -dc 'a-z-')"
  local context
  context="$(k3d cluster get "$NAME" 2>/dev/null || true)"
  echo "Cluster ${NAME} context: ${context:-[LOCAL]}"
  # Log and stdout to both
  tee /tmp/cluster-big-file 2>&1
}

# ── `k3d cluster wait` (checks if the cluster is alive — API server + nodes ready) ──

cluster_wait_for_ready() {
  # Returns 0/1; the caller decides whether to log or fail
  local cluster_name="${1:?CLUSTER}"
  while true; do
    if k3d cluster list 2>/dev/null | grep -q "$cluster_name"; then
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
    if kubectl get nodes 2>/dev/null | grep -q "Ready"; then
      echo "  ✅ API server ready"
      return 0
    fi
    # Check 2: k3d cluster get <name>/api-health
    if k3d cluster get "$cluster_name/api-health" 2>/dev/null | grep -q "OK"; then
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
    # List running clusters (context = `PROVISIONER_CLUSTER`, name = `<cluster-name-m -cluster-name-m>`)
    cluster_name="${3:-}"
    context="$(k3d cluster get "$cluster_name" 2>/dev/null || true)"
    echo "Cluster: ${cluster_name} context: ${context:-[LOCAL]}"
    ;;
  workdir|provisioner_state|kubeconfig)
    echo "bosh"
    ;;
esac
