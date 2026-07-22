#!/usr/bin/env bash
# ensure-cluster.sh — If the management cluster is not already running, start it automatically.
#
# This script is called from `npm run dev` to ensure the management cluster exists before
# starting the dev servers. Linux: native k3s (GPU-capable — see cluster.sh for why). macOS:
# k3d, unchanged (native k3s can't run on macOS at all).

set -euo pipefail

# Never run under sudo: this is the first step of `npm run dev`, which spawns tsx/vite
# processes and writes log/state files that need to stay owned by your normal user. The one
# place real root is needed — starting the native k3s systemd service — is scoped internally
# (cluster.sh's `sudo systemctl start ...`) and prompts on its own; it doesn't need this whole
# script (or the rest of `npm run dev`) to already be root.
if [ "$(id -u)" -eq 0 ]; then
  echo "❌ Do not run 'npm run dev' (or this script) with sudo — it'll leave dev-server files"
  echo "   root-owned and break things like Vite. The native k3s start step prompts for sudo"
  echo "   on its own, only when actually needed."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${ROOT}/.k3d-cluster-state"
CLUSTER_FILE="${STATE_DIR}/cluster"

K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi

if [ "$(uname -s)" = "Linux" ]; then
  # cluster.sh create already no-ops cheaply (a single `systemctl is-active` check) when the
  # native k3s instance is already running, so there's no need for a separate cached fast path
  # here — it also only prompts for sudo when actually starting the service, once per boot.
  "${ROOT}/scripts/cluster.sh" create provisioning-lunorica
else
  # Check if the k3d cluster is already up using the resolved K3D binary
  if [ -f "$CLUSTER_FILE" ] && "$K3D" cluster list 2>/dev/null | grep -q "provisioning-lunorica"; then
    CLUSTER="$(cat "$CLUSTER_FILE")"
    echo "  ▶  cluster=${CLUSTER} already running — skipping setup"
  else
    # Cluster is not running — start it (cluster.sh create will install k3d if needed)
    "${ROOT}/scripts/cluster.sh" create provisioning-lunorica

    # Save state so `npm run dev` can skip
    mkdir -p "$STATE_DIR"
    echo "provisioning-lunorica" > "$CLUSTER_FILE"
  fi
fi

# Guard against a stale in-cluster worker pod competing with the local `dev:worker:cluster`
# process for the same Temporal task queue (cluster-ops-queue). The pod is only ever deployed
# manually (`npm run deploy-worker`) and persists across `npm run dev` sessions since it lives
# in the cluster, not the npm process — scale it to 0 so local dev always wins, without
# touching the manifest itself so `npm run deploy-worker` still works when deliberately wanted.
if "$KUBECTL" --context "k3d-provisioning-lunorica" get deployment provisioning-worker &>/dev/null; then
  echo "  ▶  scaling down in-cluster worker pod (avoids stale-code conflicts with local dev)"
  "$KUBECTL" --context "k3d-provisioning-lunorica" scale deployment/provisioning-worker --replicas=0 || true
fi

# Cluster is running, setup complete.