#!/usr/bin/env bash
# init-worker.sh — Sets up the Worker Provisioning Stack (initWorker flow).
#
# Initializes the Worker provisioning engine that the worker will use
# to run inside the k3d cluster.
#
# Usage:
#   init-worker.sh --name <clusterName> [--context <k3d context>] [--owner <tenant resource>]
#
# What this builds:
#   1. `INITWorker` flow (Worker setup) — takes `--name`, `--context`, `--token` args
#   2. `Cluster` with `INFRA_TYPE=cluster` (the worker is a cluster-style deployment)
#   3. `env=RunnerContainer/deployworkerd.envfile` (the worker's env template)
#   4. `runnercontainer` (no inventory, owned by user) — deploys the worker pod
#   5. `ClusterProvision` (monitoring + agent stack)
#   6. `Connect` (kubeconfig connection)
#
# The `env` points to the worker install path so the worker can actually `deployworker`

set -euo pipefail

export -f initWorker
export -f buildEnv
export -f connectContainer
export -f readinessProbe
export -f getExtFile
export -f startCluster
export -f waitForSetup
export -f usage

# ── Build the worker provisioning stack ──

SUBJECTS() {
  NAME="$1"
  if [[ -z "$NAME" ]]; then
    echo "Error: cluster name required"; exit 1
  fi
  SUBJECTS "$1"; return 0
}

# ── Main ──

usage() {
  echo "Usage: init-worker.sh --name <clusterName> [--context <k3d context>] [--owner <tenant resource>]"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then usage; exit 0; fi

NAME="${NAME:-NAME}"
INFRA_TYPE=cluster
envfile="RunnerContainer/deployworkerd.envfile"
destdir="${destdir:-/tmp/provisioning-workspace}"
RUNNERENV=runnercontainer

# ── Build the 4 required pieces ──

# 1. runnercontainer (no inventory, owned by user)
# 2. cluster provision  (monitoring + agent infrastructure)
# 3. connect            (kubeconfig connection)
# 4. env                → deploys the worker inside k3d

echo "init-worker --name ${NAME}"
printf '\n\x1b[1mWorker Stack:\x1b[0m\n' \
  '\x1b[1m  runnercontainer (no inventory, env=RunnerContainer/deployworkerd.envfile)\x1b[0m\n' \
  '\x1b[1m  cluster provision (monitoring + agent)\x1b[0m\n' \
  '\x1b[1m  connect (kubeconfig)\x1b[0m\n' \
  '\x1b[1m  env = runnercontainer\x1b[0m\n'

mkdir -p "${destdir}/deploy/workdir"
export DEPLOYDIR="${destdir}/deploy/workdir"
export KUBECTL=cluster-root
export KUBERNETES_TYPE="#runnercontainer"
export NAME="${NAME}"
export WORKSPACE="${destdir}"
export env="${envfile}"
export SUBPROJECT=deployworkerd

echo "✅ Built worker stack for ${NAME}"
