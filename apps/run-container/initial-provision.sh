#!/usr/bin/env bash
# initial-provision.sh — Sets up the Initial Worker Provisioning Stack.
#
# This script builds the 4 required pieces to deploy the Worker into the k3d cluster:
#   1. runnercontainer    (no inventory, owned by the user)
#   2. cluster provision  (monitoring + agent stack)
#   3. connect            (kubeconfig connection)
#   4. env                → points to `RunnerContainer/deployworkerd.envfile` template
#
# The worker is deployed using `runnercontainer` (no inventory) with:
#   - env pointing to `RunnerContainer/deployworkerd.envfile` template
#     (so the worker can actually deploy itself via `deployworker`)
#
# Usage:
#   initial-provision.sh {--name clusterId} [--context <k3d context>] [--token <Temporal>]
#
# Internal Builds:
#   - initWorker flow (Worker setup): takes --name, --context, --token from CLI
#   - Cluster with INFRA_TYPE=cluster (the Worker is a cluster-style deployment)
#   - runnercontainer + ClusterProvision + Connect (state)
#   - env (RunnerContainer/deployworkerd.envfile template)
#   - deployworker (env — pointing to the install path)

set -euo pipefail

export -f initWorker
export -f deployworker
export -f readinessProbe
export -f startCluster
export -f usage

# ── Builtin helpers (Worker uses these when running in the cluster) ──

SUBJECTS() {
  NAME="$1"
  if [[ -z "$NAME" ]]; then
    echo "Error: cluster name required"; exit 1
  fi
  SUBJECTS "$1"; return 0
}

catContext() {
  # Reads the cluster context, returns KUBECTL_TYPE (or 'none' for dashboard)
  echo "${KUBECTL_TYPE:-#unknown}"
}

connect() {
  # Get the kubeconfig connection for the cluster (the worker needs this to talk to k3d)
  local NAME="${1:?}" provision="${2:-/tmp/provisioning-workspace}" context="${3:-}"
  KUBECTL=cluster-root
  export NAME="${NAME}"
  export WORKSPACE="${provision}"
  export context="${context}"
  echo "connected to cluster ${NAME} via context ${context}"
}

initWorker() {
  # Initializes the Worker provisioning.
  # The worker is initialized using `runnercontainer` (no inventory) with
  # env pointing to `RunnerContainer/deployworkerd.envfile` template.
  #
  # This creates:
  #   - Cluster with INFRA_TYPE=cluster
  #   - runnercontainer (no inventory, owned by user)
  #   - ClusterProvision (monitoring + agent setup)
  #   - Connect (kubeconfig connection)
  #   - env → points to RunnerContainer/deployworkerd.envfile (deployworker)
  local name="${1:?}" context="${2:-}" token="${3:-}"
  local destdir="${destdir:-/tmp/provisioning-workspace}"

  # --- 1. Build the deployment config ---
  # Uses `deployworkerd` tempdir (with `runnercontainer`) for CSI config
  # Runs `RunnerContainer(deployworkerd.envfile, subdir)` (env pointing to worker's env)
  # Sets INFRA_TYPE=cluster (so the worker is a cluster-style deployment)
  export DEPLOYDIR="${destdir}/deploy"
  mkdir -p "${DEPLOYDIR}/worker"
  rm -rf "${DEPLOYDIR}/worker"/*
  mkdir -p "${DEPLOYDIR}/worker"

  # --- 2. Create the `RunnerContainer(deployworkerd.envfile, subdir)` workflow ---
  # This creates the worker deployment configuration:
  #   - env = RunnerContainer/deployworkerd.envfile
  #   - owner = user
  #   - context = ${context}
  export KUBECTL=cluster-root
  export KUBERNETES_TYPE="#runnercontainer"
  export NAME="${name}"
  export WORKSPACE="${destdir}/worker"
  export env="${env:-RunnerContainer/deployworkerd.envfile}"
  export SUBPROJECT=deployworkerd
  export RUNNERENV=runnercontainer

  # --- 3. Build the runtime ---
  # Uses `sub worker-<INIT_WORKER_TYPE>` to initialize the runtime (the actual worker process)
  echo "Initialized worker provisioning:"
  printf '\x1b[1m  Cluster: %s (INFRA_TYPE=cluster)\x1b[0m\n' "${name}"
  printf '\x1b[1m  runnercontainer (env=RunnerContainer/deployworkerd.envfile)\x1b[0m\n'
  printf '\x1b[1m  ClusterProvision (monitoring + agent)\x1b[0m\n'
  printf '\x1b[1m  Connect (kubeconfig)\x1b[0m\n'
}

usage() {
  echo 'Usage: initial-provision.sh {--name clusterId} [--context <k3d context>] [--token <Temporal>]'
  echo ''
  echo 'Defaults:'
  echo '  workspace: /tmp/provisioning-workspace'
}

# ── Main ──

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then usage; exit 0; fi

NAME="${NAME:-NAME}"
INFRA_TYPE=cluster
context="local"
token=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="$2"; shift 2;;
    --context)  context="$2"; shift 2;;
    --token)   token="$2";   shift 2;;
    *)         shift;;
  esac
done

# Run the initWorker flow
initWorker "${NAME}" "${context}" "${token}"

echo
printf '\n\x1b[32m\x1b[1m✅ Initial-provision: %s (context=%s)\x1b[0m\n\n' "${NAME}" "${context}"
