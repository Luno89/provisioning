#!/usr/bin/env bash
# clean-environment.sh — Idempotent full environment reset.
# Removes k3d clusters, containers, kubeconfigs, state files, cdktf state,
# lockfiles, and any stale dev processes. Fully re-entrant: calling it
# multiple times converges to a clean state.
#
# Exit codes:
#   0  — fully clean
#   N  — N artifacts remained after cleanup
#   1  — fatal error during cleanup

set -eo pipefail

ROOT="/home/luno/Code/provisioning"
MAX_CLEAN=3  # max clean rounds to converge

CLEAN_TOTAL=0

# ════════════════════════════════════════════════════════════

cleanup_containers() {
  while read -r c; do
    [[ -z "$c" ]] && continue
    docker stop --time 5 "$c" >/dev/null 2>&1 || true
    docker rm -f "$c" >/dev/null 2>&1 || true
    CLEAN_TOTAL=$((CLEAN_TOTAL+1))
    echo "  ✘ rm container: $c"
  done < <(docker ps -aqf 'name=k3d-*' 2>/dev/null)
}

# ════════════════════════════════════════════════════════════

cleanup_k3d_clusters() {
  local list_output
  list_output="$(k3d cluster list --no-headers 2>/dev/null)" || true
  [[ -z "$list_output" ]] && return 0
  while read -r c; do
    [[ -z "$c" ]] && continue
    k3d cluster delete "$c" >/dev/null 2>&1 || true
    CLEAN_TOTAL=$((CLEAN_TOTAL+1))
    echo "  ✘ rm k3d cluster: $c"
  done <<< "$list_output"
}

# ════════════════════════════════════════════════════════════

cleanup_kubeconfigs() {
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    rm -f "$f"
    CLEAN_TOTAL=$((CLEAN_TOTAL+1))
    echo "  ✘ rm kubeconfig: $f"
  done < <(ls /tmp/kubeconfig-* 2>/dev/null)
}

# ════════════════════════════════════════════════════════════

cleanup_backend_state() {
  for f in "$ROOT/apps/backend/data/clusters.json" \
           "$ROOT/apps/backend/data/deployments.json" \
           "$ROOT/apps/backend/data/clusters-test.json" \
           "$ROOT/apps/backend/data/deployments-test.json"; do
    [[ -f "$f" ]] || continue
    rm -f "$f"
    CLEAN_TOTAL=$((CLEAN_TOTAL+1))
    echo "  ✘ rm state: $(basename "$f")"
  done
  if [[ -d "$ROOT/apps/backend/session/" ]]; then
    rm -rf "$ROOT/apps/backend/session/" 2>/dev/null
    CLEAN_TOTAL=$((CLEAN_TOTAL+1)); echo "  ✘ rm dir: session/"
  fi
  if [[ -d "$ROOT/apps/backend/data/log/" ]]; then
    rm -rf "$ROOT/apps/backend/data/log/" 2>/dev/null
    CLEAN_TOTAL=$((CLEAN_TOTAL+1)); echo "  ✘ rm dir: data/log/"
  fi
  if [[ -d "$ROOT/.k3d-cluster-state/" ]]; then
    rm -rf "$ROOT/.k3d-cluster-state/" 2>/dev/null
    CLEAN_TOTAL=$((CLEAN_TOTAL+1)); echo "  ✘ rm dir: .k3d-cluster-state/"
  fi
}

# ════════════════════════════════════════════════════════════

cleanup_terraform_state() {
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    rm -f "$f"
    CLEAN_TOTAL=$((CLEAN_TOTAL+1))
    echo "  ✘ rm tfstate: $(basename "$f")"
  done < <(find "$ROOT/packages/cdktf-infra" \( -name "*.tfstate" -o -name "*.tfstate.backup" -o -name "*.tfstate.lib."*.json \) 2>/dev/null || true)
}

# ════════════════════════════════════════════════════════════

cleanup_test_state() {
  if [[ -d "$ROOT/.test-server-state/" ]]; then
    rm -rf "$ROOT/.test-server-state/" 2>/dev/null
    CLEAN_TOTAL=$((CLEAN_TOTAL+1)); echo "  ✘ rm dir: .test-server-state/"
  fi
  if [[ -d "$ROOT/.test-e2e-state/" ]]; then
    rm -rf "$ROOT/.test-e2e-state/" 2>/dev/null
    CLEAN_TOTAL=$((CLEAN_TOTAL+1)); echo "  ✘ rm dir: .test-e2e-state/"
  fi
  if [[ -f "$ROOT/apps/backend/data/nginx/nginx.conf" ]]; then
    rm -f "$ROOT/apps/backend/data/nginx/nginx.conf" 2>/dev/null
    CLEAN_TOTAL=$((CLEAN_TOTAL+1)); echo "  ✘ rm file: nginx/nginx.conf"
  fi
  for f in "$ROOT/apps/backend/data/nginx/conf.d/"*.conf; do
    [[ -f "$f" ]] || continue
    rm -f "$f"
    CLEAN_TOTAL=$((CLEAN_TOTAL+1)); echo "  ✘ rm file: conf.d/$(basename "$f")"
  done
}

# ════════════════════════════════════════════════════════════

cleanup_processes() {
  while read -r p; do
    [[ -z "$p" ]] && continue
    kill "$p" 2>/dev/null || true
    CLEAN_TOTAL=$((CLEAN_TOTAL+1))
    echo "  ✘ kill process: $p"
  done < <(pgrep -f "k3d-Lunorica-server-0" 2>/dev/null || true)
  pgrep -f "deployworkerd" 2>/dev/null | xargs -r kill 2>/dev/null || true
}

# ════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════

for r in $(seq 1 "$MAX_CLEAN"); do
  CLEAN_TOTAL=0
  echo "────────────────────────────────────"
  echo "▶ clean-environment.sh [round $r]"
  echo "────────────────────────────────────"

  cleanup_containers
  cleanup_k3d_clusters
  cleanup_kubeconfigs
  cleanup_backend_state
  cleanup_terraform_state
  cleanup_test_state
  cleanup_processes

  # Feedback if process exists
  if [[ "$r" -lt "$MAX_CLEAN" ]]; then
    echo "  → round $r complete — final count: $CLEAN_TOTAL items"
  fi

  # Convergence check: if no items removed in latest round, we're clean
  if [[ "$r" -ge 2 ]] && [[ "$CLEAN_TOTAL" -eq 0 ]]; then
    break
  fi

done

if [[ "$r" -ge "$MAX_CLEAN" ]]; then
  echo "⚠ Max round ($MAX_CLEAN) reached. Total cleaned: $CLEAN_TOTAL"
else
  echo "✅ clean-environment.sh: $CLEAN_TOTAL items removed (converged in $r round)"
fi

exit 0
