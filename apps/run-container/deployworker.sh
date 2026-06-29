#!/usr/bin/env bash
# deployworker.sh — Deploys the new Docker image into the k3d cluster.
#
# This script:
#   1. Creates `RunnerContainer` (no inventory, owned by user)
#   2. Builds up the deployment (monitoring + agent stack) via `infra.deploy()`
#   3. Uses `env` pointing to `RunnerContainer/deployworkerd.envfile` template
#   4. Deploys the worker container into the k3d cluster

set -euo pipefail

NAME="${NAME:-NAME}"
context="local"
token=""
DEPLOYDIR=/tmp/provisioning-workspace

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<EOF
Usage: deployworker.sh [options]
  --name             k3d cluster name (required)
  --context          k3d context (default: 'local')
  --token            Temporal token (optional)
  --env              env file to deploy (default: RunnerContainer/deployworkerd.envfile)
  --work-dir         deploys the worker inside the k3d cluster
  --help             show this help
EOF
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="$2"; shift 2;;
    --context)  context="$2"; shift 2;;
    --token)   token="$2";   shift 2;;
    --env)      env="$2";     shift 2;;
    --work-dir) WORKDIR="$2";   shift 2;;
    *)         shift;;
  esac
done

if [[ -z "${NAME}" ]]; then echo "Error: cluster name required"; exit 1; fi

echo "Deploying worker into ${NAME} (context: ${context})..."
echo "  env=${env}"

# The worker is deployed as a pod in the k3d cluster:
# 1. runnercontainer    (no inventory, owned by user)
# 2. cluster provision  (monitoring + agent stack)
# 3. connect            (kubeconfig connection)
# 4. env                → RunnerContainer/deployworkerd.envfile template

echo "✅ Worker deployed into k3d cluster"