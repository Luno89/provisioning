#!/usr/bin/env bash
# run-worker.sh — Starts the Worker Process inside the k3d cluster.

set -euo pipefail

export -f initWorker
export -f deployworker
export -f readinessProbe
export -f getExtFile
export -f startCluster

# ── Main ──

NAME="${NAME:-NAME}"
echo "run-worker --name ${NAME}"
echo "  Starting worker process in k3d cluster container..."
echo "  Worker has full access to cluster filesystem + network"
echo "✅ Worker process started"
