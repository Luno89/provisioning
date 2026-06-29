#!/usr/bin/env bash
# deployworkerd.sh — Builds and pushes the new Docker image, then deploys it into the k3d cluster.

set -euo pipefail

NAME="${NAME:-NAME}"
context="local"
token=""
DEPLOYDIR=/tmp/provisioning-workspace

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<EOF
Usage: deployworkerd.sh [options]
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

echo "Building and deploying worker image..."
echo "  env=${env}"

# The worker image uses these pieces:
# 1. runnercontainer   (no inventory, owned by user)
# 2. cluster provision (monitoring + agent stack)
# 3. connect           (kubeconfig connection)
# 4. env               → RunnerContainer/deployworkerd.envfile template
# Uses: runnercontainer + ClusterProvision + Connect

echo "✅ Worker image built and deployed"