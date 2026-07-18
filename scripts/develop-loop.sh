#!/usr/bin/env bash
# develop-loop.sh — Automated iterative dev loop for provisioning.
# Cleans state → build worker image → start dev stack → provision cluster
# via POST /api/clusters → wait → verify-cluster.sh
# Max 15 iterations before failing.
#
# Usage:  develop-loop.sh [cluster-name] [--verbose]
#
# Exit codes:
#   0 — healthy
#   1 — max iterations hit
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-3001}"
MAX_ITER=15
VERBOSE=0
CLUSTER_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--verbose) VERBOSE=1;   shift ;;
    *)             CLUSTER_NAME="$1"; shift ;;
  esac
done
[[ -z "$CLUSTER_NAME" ]] && CLUSTER_NAME="new-cluster-$(hostname | tr 'a-z' 'A-Z' | tr -cd 'A-Z0-9' 2>/dev/null || echo LOCAL)"

ITER=0
mkdir -p "${ROOT}/logs/loop-dev/${CLUSTER_NAME}"

mark() { echo "────────────────────────────────────"; echo "▶ Step $1 ($2)"; echo "────────────────────────────────────" >> "${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log" 2>&1; }
log()  { echo "  $1" >> "${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log" 2>&1; }

pass()  { echo "  ✅ $1"; log "✅ $1"; }
fail()  { echo "  ❌ $1"; log "❌ $1"; }
warn()  { echo "  ⚠️  $1"; log "⚠️  $1"; }
info()  { echo "  ℹ️  $1"; }

echo "═══════════════════════════════════════════"
echo "┌  loop-dev — cluster=${CLUSTER_NAME}"
echo "│  Max=${MAX_ITER}  Verbose=${VERBOSE}  Iter=${ITER}"
echo "═══════════════════════════════════════════"

inner_iterate() {
  # 1. Reset
  mark "clean-environment.sh" "spacer"
  bash "${ROOT}/scripts/clean-environment.sh" 2>>"${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log"
  echo "" >> "${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log"

  # 2. Ensure Temporal is running
  mark "ensure-temporal.sh" "spacer"
  bash "${ROOT}/scripts/ensure-temporal.sh" 2>>"${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log"
  echo "" >> "${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log"

  # 3. Start backend + frontend
  mark "npm run dev (start dev stack)" "spacer"
  npm run dev -w apps/backend  2>>"${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log" &
  echo $! >"${ROOT}/logs/loop-dev/${CLUSTER_NAME}/pid_backend.log"
  npm run dev -w apps/frontend -- --port 5174 2>>"${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log" &
  echo $! >"${ROOT}/logs/loop-dev/${CLUSTER_NAME}/pid_frontend.log"
  echo "" >> "${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log"

  # Boot backend :3001 and frontend :5174
  while ! ss -tln 2>/dev/null | grep -q ":${BACKEND_PORT}";  do sleep 2; done
  while ! ss -tln 2>/dev/null | grep -q ":5174";  do sleep 2; done
  pass "Back:${BACKEND_PORT}  Front:5174"

  # 4. Reset state DB (so provision starts from a clean write)
  mark "Reset clusters.json / deployments.json" "spacer"
  rm -f "${ROOT}/apps/backend/data/clusters.json" "${ROOT}/apps/backend/data/deployments.json"
  pass "state files reset"

  # 5. Provision cluster via POST /api/clusters
  mark "POST /api/clusters → ${CLUSTER_NAME}" "spacer"
  url="${BACKEND_PORT}/api/clusters"
  if (curl -s --max-time 10 -X POST "http://localhost:${BACKEND_PORT}/api/clusters" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"${CLUSTER_NAME}\", \"provider\": \"k3d\"}") \
    >> "${ROOT}/logs/loop-dev/${CLUSTER_NAME}/offer.json" 2>>"${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log"; then
    pass "POST /api/clusters: 200"
  else
    warn "POST /api/clusters non-200"
    return 1
  fi
  echo "" >> "${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log"

  # 6. Wait for cluster provisioning workflow to finish
  mark "sleep 90s — cluster workflow completes" "spacer"
  sleep 90
  echo "" >> "${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log"

  # 7. Verify cluster
  mark "verify-cluster.sh" "spacer"
  if bash "${ROOT}/scripts/verify-cluster.sh" "${CLUSTER_NAME}" --verbose 2>>"${ROOT}/logs/loop-dev/${CLUSTER_NAME}/OUT.log"; then
    pass "✅ cluster=${CLUSTER_NAME} healthy (15 checks passed)"
    return 0
  else
    warn "verify-cluster.sh FAILED"
    return 1
  fi
}

iterate() {
  # Initial clean
  bash "${ROOT}/scripts/clean-environment.sh" 2>/dev/null
  echo ""
  # First run
  ITER=$((ITER+1))
  info "◆ cycle ${ITER} / ${MAX_ITER} — cluster=${CLUSTER_NAME}"
  inner_iterate
}

iterate || {
  echo "────────────────────────────────────"
  fail "max iterations hit ($MAX_ITER) — cluster=${CLUSTER_NAME}"
  warn "check ${ROOT}/logs/loop-dev/${CLUSTER_NAME}/"
  return 1
}
return 0
