#!/usr/bin/env bash
# clean-environment.test.sh — Validates the clean script with fake artifacts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Setup fake artifacts ──────────────────────────────────────────────
echo "▶ Setup fake artifacts..."
touch /tmp/kubeconfig-test-abc
echo "state-dirty" > "$ROOT/apps/backend/data/clusters.json"
echo "deployments" > "$ROOT/apps/backend/data/deployments.json"
echo "test-clusters" > "$ROOT/apps/backend/data/clusters-test.json"
mkdir -p "$ROOT/.k3d-cluster-state"
echo "state-dirty" > "$ROOT/.k3d-cluster-state/cluster"
mkdir -p "$ROOT/apps/backend/data/log"
echo "debug" > "$ROOT/apps/backend/data/log/existing.log"
mkdir -p "$ROOT/apps/backend/session/file"
echo "stale" > "$ROOT/apps/backend/session/file/abc"
echo "aaaa" > "$ROOT/packages/cdktf-infra/terraform.test-app.tfstate"
echo "backup" > "$ROOT/packages/cdktf-infra/terraform.test-app.tfstate.backup"

# ── Run the real script with MAX_CLEAN overridden ─────────────────────
echo ""
echo "▶ Running clean-environment.sh"
bash "$ROOT/scripts/clean-environment.sh"
RC=$?
echo ""
echo "EXIT: $RC"

# ── Validate state files removed ──────────────────────────────────────
echo ""
echo "▶ Validation."
echo "  clusters.json exists: $([ -f \"\$ROOT/apps/backend/data/clusters.json\" ] && echo YES || echo NO)"
echo "  deployments.json exists: $([ -f \"\$ROOT/apps/backend/data/deployments.json\" ] && echo YES || echo NO)"
echo "  clusters-test.json exists: $([ -f \"\$ROOT/apps/backend/data/clusters-test.json\" ] && echo YES || echo NO)"
echo "  deployments-test.json exists: $([ -f \"\$ROOT/apps/backend/data/deployments-test.json\" ] && echo YES || echo NO)"
echo "  kubeconfig-test-abc exists: $([ -f /tmp/kubeconfig-test-abc ] && echo YES || echo NO)"
echo "  .k3d-cluster-state exists: $([-d \"\$ROOT/.k3d-cluster-state/\" ] && echo YES || echo NO)"
echo "  session/ exists: $([-d \"\$ROOT/apps/backend/session/\" ] && echo YES || echo NO)"
echo "  tfstate.test-app exists: $([ -f \"\$ROOT/packages/cdktf-infra/terraform.test-app.tfstate\" ] && echo YES || echo NO)"
echo "  tfstate.backup exists: $([ -f \"\$ROOT/packages/cdktf-infra/terraform.test-app.tfstate.backup\" ] && echo YES || echo NO)"

# Fall back to hard exit if any artifact remains
FAILED=0
[ -f "$ROOT/apps/backend/data/clusters.json" ] && FAILED=$((FAILED+1))
[ -f "$ROOT/apps/backend/data/deployments.json" ] && FAILED=$((FAILED+1))
[ -f "$ROOT/apps/backend/data/clusters-test.json" ] && FAILED=$((FAILED+1))
[ -f "$ROOT/apps/backend/data/deployments-test.json" ] && FAILED=$((FAILED+1))
[ -f /tmp/kubeconfig-test-abc ] && FAILED=$((FAILED+1))
[ -d "$ROOT/.k3d-cluster-state/" ] && FAILED=$((FAILED+1))
[ -d "$ROOT/apps/backend/session/" ] && FAILED=$((FAILED+1))
[ -f "$ROOT/packages/cdktf-infra/terraform.test-app.tfstate" ] && FAILED=$((FAILED+1))
[ -f "$ROOT/packages/cdktf-infra/terraform.test-app.tfstate.backup" ] && FAILED=$((FAILED+1))

echo ""
echo "FAILURES: $FAILED"
[[ "$FAILED" -eq 0 ]] || exit 1

echo "✅ All artifacts removed"
exit 0
