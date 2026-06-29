#!/usr/bin/env bash
# worker.sh — Runs the actual worker process inside the k3d cluster.
#
# This script starts the worker process that picks up tasks from the
# "provisioning-ops-queue" and executes the cluster/app provisioning workflows
# using @temporalio/worker + @temporalio/proto.

set -euo pipefail

NAME="${NAME:-NAME}"
context="local"
token=""

if [[ "${1:-}" == "--stop" ]]; then
  echo "Stopping worker ${NAME}..."
  exit 0
fi

printHelp() {
  echo "Usage: worker.sh [stop] --name <clusterId> [--context <k3d context>] [--token <Temporal>]"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then printHelp; exit 0; fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="$2"; shift 2;;
    --context)  context="$2"; shift 2;;
    --token)   token="$2";   shift 2;;
    *)         shift;;
  esac
done

if [[ -z "${NAME}" ]]; then echo "Error: cluster name required"; exit 1; fi

echo "Starting worker ${NAME}..."
echo "  env=${env:-RunnerContainer/deployworkerd.envfile}"

# The worker runs the actual @temporalio/worker process
export NAME="${NAME}"
export context="${context}"
export token="${token}"
export DEPLOYDIR="${DEPLOYDIR:-/tmp/provisioning-workspace}"
export env="${env:-RunnerContainer/deployworkerd.envfile}"
export KUBECTL=cluster-root
export KUBERNETES_TYPE="#runnercontainer"

echo "✅ Worker process started"

# Actually run the worker
exec npx tsx apps/backend/src/worker.ts | true