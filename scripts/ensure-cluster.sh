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

# Resolve which context to use: prefer the k3d-named context if it exists, else default.
CLUSTER_CONTEXT="k3d-provisioning-lunorica"
if ! "$KUBECTL" config get-contexts -o name 2>/dev/null | grep -qx "$CLUSTER_CONTEXT"; then
  if "$KUBECTL" get nodes >/dev/null 2>&1; then
    CLUSTER_CONTEXT="$( "$KUBECTL" config current-context 2>/dev/null || echo default )"
  else
    echo "  ❌  No reachable cluster — run ensure-cluster.sh after the cluster is up"
    exit 1
  fi
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
if "$KUBECTL" --context "$CLUSTER_CONTEXT" get deployment provisioning-worker &>/dev/null; then
  echo "  ▶  scaling down in-cluster worker pod (avoids stale-code conflicts with local dev)"
  "$KUBECTL" --context "$CLUSTER_CONTEXT" scale deployment/provisioning-worker --replicas=0 || true
fi

# Create the worker log directory BEFORE the stack apply below. LoggingStack mounts this exact
# path into promtail as `hostPath: { type: DirectoryOrCreate }` (constructs/logging.ts), and
# kubelet creates a missing DirectoryOrCreate path as root:root 0755. `clean-dev` wipes data/, so
# on a fresh setup promtail would win the race and the host workers — which run as the invoking
# user — then fail with EACCES on their own log file. Creating it here means the mount finds an
# existing directory and leaves ownership alone.
mkdir -p "${ROOT}/apps/backend/data/logs/workers"

# Prometheus/Grafana/Traefik: every other cluster gets these automatically via
# ProvisionClusterActivity's CDKTF apply, but the management cluster bootstraps outside that
# workflow entirely (this script, plus scripts/cluster.sh — no CDKTF involved), so nothing has
# ever applied that stack to it. Idempotent — cheap fast-path skip when already installed.
npx tsx "${ROOT}/scripts/ensure-cluster-stack.ts" || echo "  ⚠️  Monitoring/ingress stack check failed — continuing anyway"

# The egress proxy every sandbox installs through.
#
# Applied here rather than by hand because it is load-bearing: `packageAccess()` in
# lib/workspace-spec.ts points every Python and Go workspace at
# `egress-proxy.koala-egress.svc.cluster.local:8888` and writes a NetworkPolicy rule permitting it.
# On a cluster where this was never applied, that rule names a namespace that does not exist, so
# `pip install` hangs and then reports a connection error — which reads as PyPI being down rather
# than as missing infrastructure. `clean-dev` deletes the k3d cluster, so "never applied" is the
# state of every fresh machine.
#
# Idempotent: `apply` on an unchanged manifest is a no-op.
"$KUBECTL" --context "$CLUSTER_CONTEXT" apply -f "${ROOT}/k8s/koala-egress/" \
  || echo "  ⚠️  Egress proxy apply failed — sandboxes will not be able to install packages"

# SearXNG + Crawl4AI: the agent's web_search / fetch_web_page tools fall back to
# DuckDuckGo + raw-HTML stripping when these aren't running, which silently breaks
# when DDG serves a CAPTCHA or the page renders client-side. Same pattern as the
# egress proxy: plain YAML applied to the management cluster, idempotent.
"$KUBECTL" --context "$CLUSTER_CONTEXT" apply -f "${ROOT}/k8s/searxng/" \
  || echo "  ⚠️  SearXNG apply failed — web_search will fall back to DuckDuckGo"
"$KUBECTL" --context "$CLUSTER_CONTEXT" apply -f "${ROOT}/k8s/crawl4ai/" \
  || echo "  ⚠️  Crawl4AI apply failed — fetch_web_page will fall back to raw HTML stripping"

# Point the backend at the in-cluster services. NodePorts are reachable on localhost
# for both native k3s (binds on host) and k3d (forwards from host). Overwrite any stale
# values (e.g. from a previous docker-compose approach).
ENV_FILE="${ROOT}/apps/backend/.env"
if [ -f "$ENV_FILE" ]; then
  for line in \
    'SEARXNG_URL=http://127.0.0.1:32080' \
    'CRAWL4AI_URL=http://127.0.0.1:31235' \
    'CRAWL4AI_API_TOKEN=koala-dev-crawl4ai-token'; do
    key="${line%%=*}"
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
      sed -i "s|^${key}=.*|${line}|" "$ENV_FILE"
    else
      echo "$line" >> "$ENV_FILE"
    fi
  done
fi

# Cluster is running, setup complete.