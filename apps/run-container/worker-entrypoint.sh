#!/usr/bin/env bash
# worker-entrypoint.sh — The actual Worker Entry Point.
#
# This script runs the real Temporal worker inside the k3d cluster. It:
#   1. Uses `runnercontainer` (no inventory, owned by user)
#   2. Uses `ClusterProvision` (monitoring + agent stack)
#   3. Uses `Connect` (kubeconfig connection)
#   4. Uses `env` pointing to `RunnerContainer/deployworkerd.envfile` template
#
# Usage:
#   worker-entrypoint.sh <clusterId> [--context <k3d context>] [--token <Temporal>]

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: worker-entrypoint.sh <clusterId> [--context <k3d context>] [--token <Temporal>]"
  exit 0
fi

# Parse args
export NAME="${1:-NAME}"
export context="${2:-local}"
export token="${3:-}"

if [[ "${1:-}" == --stop ]]; then
  echo "Stopping worker ${NAME}..."
  exit 0
fi

# ── Build the 4 required pieces ──

printf '\n[1mBuilding worker stack:[0m\n' \
  '[1m  runnercontainer [no inventory, env=RunnerContainer/deployworkerd.envfile][0m\n' \
  '[1m  cluster provision (monitoring + agent)[0m\n' \
  '[1m  connect (kubeconfig)[0m\n' \
  '[1m  entry: RunnerContainer/deployworkerd.envfile[0m\n'

# ── Spawn actual worker process (exec — replaces this shell) ──

# Use the actual worker binary from backend/src (which runs the ClusterProvisionWorkflow + ProvisionClusterActivity)

exec npx tsx "apps/backend/src/worker.ts" --start "${NAME}" --context "${context}"

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<EOF
Usage: worker-entrypoint.sh [stop] --name <clusterId> [--context <k3d context>] [--token <Temporal token>]

  --name    k3d cluster name (required)
  --context k3d context (default: 'local')
  --token   Temporal token (optional)
  --help    show this help
EOF
  exit 0
fi

if [[ "${1:-}" == "--stop" ]]; then
  echo "Stopping worker ${NAME:-NAME}..."
  exit 0
fi

NAME="${NAME:-NAME}"
context="${context:-local}"
token="${token:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="$2"; shift 2;;
    --context) context="$2"; shift 2;;
    --token)   token="$2";   shift 2;;
    *)         shift;;
  esac
done

# ── Build the 4 required pieces ─

# 1. runnercontainer   (no inventory, owned by user)
# 2. cluster provision (monitoring + agent stack)
# 3. connect           (kubeconfig connection)
# 4. env               → RunnerContainer/deployworkerd.envfile template

printf '\n[1mBuilding worker stack:[0m\n'
printf '  [1m  runnercontainer [no inventory, env=RunnerContainer/deployworkerd.envfile][0m\n'
printf '  [1m  cluster provision (monitoring + agent)[0m\n'
printf '  [1m  connect (kubeconfig)[0m\n'
printf '  [1m  entry: RunnerContainer/deployworkerd.envfile[0m\n'

# ── Spawn npx to build the stacks ─

exec npx tsx "$0" --name "${NAME}" --context "${context}"
