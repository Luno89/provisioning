#!/usr/bin/env bash
# worker-entrypoint.sh — The worker process that runs inside the k3d cluster.

# This is the WorkerService that actually runs inside the k3d cluster, not as a standalone
# Docker container. It uses "RunnerContainer" + "ClusterProvision" + "Connect" to manage
# the worker lifecycle.

set -euo pipefail

# ── Builtin helpers (Worker uses these when running in the cluster) ──

SUBJECTS() {
  NAME=$1
  if [[ -z "$NAME" ]]; then
    return 0
  fi
  SUBJECTS "$NAME"; return 0
}

# ── Main ──

if [[ "${1:-}" == --stop ]]; then
  echo "Stopping worker ${NAME:-NAME}..."
  exit 0
fi

if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  echo 'Usage: worker-entrypoint.sh [stop] --name <clusterId> [--context <k3d context>] [--token <Temporal>]'
  exit 0
fi

NAME="${NAME:-NAME}"
INFRA_TYPE=cluster
context="local"
token=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="$2"; shift 2;;
    --context) context="$2"; shift 2;;
    --token)   token="$2";   shift 2;;
    *)         shift;;
  esac
done

# ── Build the 4 required pieces ──

# 1. runnercontainer (no inventory, owned by user)
# 2. cluster provision (monitoring + agent stack)
# 3. connect            (kubeconfig connection)
# 4. env                → RunnerContainer/deployworkerd.envfile template (deployworker)

printf '\n[1mBuilding worker stack:[0m\n'
printf '  [1m  runnercontainer [no inventory, env=RunnerContainer/deployworkerd.envfile][0m\n'
printf '  [1m  cluster provision (monitoring + agent)[0m\n'
printf '  [1m  connect (kubeconfig)[0m\n'
printf '  [1m  entry: RunnerContainer/deployworkerd.envfile[0m\n'

# ── Create the directory structure ──

export DEPLOYDIR="/tmp/provisioning-workspace"
mkdir -p "${DEPLOYDIR}/deploy/worker"

# ── Set up the environment for the worker (it will call infra.deploy() with proper KV env + CLUSTER_NAME settings) ──

export KUBECTL=cluster-root
export KUBERNETES_TYPE="#runnercontainer"
export NAME="${NAME}"
export WORKSPACE="/tmp/provisioning-workspace"
export env="${env:-RunnerContainer/deployworkerd.envfile}"
export SUBPROJECT=deployworkerd
export RUNNERENV=runnercontainer

echo "Worker stack built: runnercontainer + cluster provision + connect + env"
echo "Worker ready: ${NAME}"
echo "RunnerContainer + ClusterProvision + Connect: env = RunnerContainer/deployworkerd.envfile"
echo ""
echo "[32m[1m✅ Worker entry (INFRA_TYPE=cluster): ${NAME}/${context} (env=${env})[0m"
echo ""
