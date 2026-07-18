#!/usr/bin/env bash
# first-time.sh — Ensures Temporal is running and deploys the worker into the k3d cluster.
#
# This script wraps:
#   1. Ensure Temporal server is running (via ensure-temporal.sh)
#   2. Build and deploy worker image into k3d cluster (via deploy-worker.sh)
#
# Usage: first-time.sh [--deploy]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

DEPLOY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy) DEPLOY=true; shift ;;
    *) shift ;;
  esac
done

echo "🚀 Ensuring Temporal server is running..."
bash "${ROOT}/scripts/ensure-temporal.sh"

if [ "$DEPLOY" = true ]; then
  echo "🚀 Deploying worker to k3d cluster..."
  bash "${ROOT}/scripts/deploy-worker.sh"
fi
