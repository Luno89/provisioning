#!/usr/bin/env bash
# init-cluster.sh — Initializes the cluster entry point (INFRA_TYPE=cluster).

set -euo pipefail

# ── Main ──

# --- Use `runnercontainer` + `ClusterProvision` + `Connect` ---
INFRA_TYPE=cluster

# The worker needs these 4 pieces:
# 1. runnercontainer (no inventory, owned by user) → deploys the worker pod
# 2. cluster provision  (monitoring + agent stack)  → builds the actual infrastructure
# 3. connect            (kubeconfig + env vars)      → gets the kubeconfig connection
# 4. env pointing to    (RunnerContainer/deployworker.envfile) → worker install path

echo "Initialized cluster entry point with INFRA_TYPE=cluster"
echo "  - runnercontainer (no inventory)"
echo "  - cluster provision (monitoring + agent)"
echo "  - connect (kubeconfig)"
echo "  - env (entry: RunnerContainer/deployworker.envfile)"

echo "✅ Built worker: INFRA_TYPE=cluster"
