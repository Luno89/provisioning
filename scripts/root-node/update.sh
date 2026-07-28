#!/usr/bin/env bash
# update.sh — Deploy a new version of the platform onto the root node.
#
# Usage (on the root node, as root):
#   bash scripts/root-node/update.sh                    # latest origin/main
#   bash scripts/root-node/update.sh v1.2.0             # a tag, or any git ref
#   bash scripts/root-node/update.sh --force            # update despite work in flight
#
# Rollback is git-based and automatic: if the health check fails, this returns to the commit that
# was running before and restarts again.
#
# It is deliberately NOT snapshot-based. A Hetzner snapshot restores the whole disk, which on this
# host means rolling Mongo, Temporal and Headscale back too — every cluster a tenant created since
# the snapshot would vanish. Snapshots are disaster recovery for "the machine is broken", not
# "that deploy was bad". This takes one anyway when a token is available, because it is cheap
# insurance, but it never restores one automatically.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/nowrinkles}"
SERVICE="${SERVICE:-nowrinkles}"
FORCE=0
TARGET_REF=""

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *) TARGET_REF="$arg" ;;
  esac
done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
die()  { echo -e "  ${RED}❌${NC} $1"; exit 1; }
step() { echo -e "\n${GREEN}▶${NC} $1"; }

[ "$(id -u)" -eq 0 ] || die "Run as root — this restarts a systemd unit."
[ -d "$REPO_DIR/.git" ] || die "No repo at ${REPO_DIR}. Run bootstrap.sh first."
cd "$REPO_DIR"

# ── 1. Don't interrupt a tenant ────────────────────────────────────────────────────────────────
# A restart mid-provision is survivable — Temporal keeps workflow state, so the activity resumes on
# the new process rather than losing the cluster. But it does burn one of ProvisionClusterActivity's
# three attempts, and a tenant watching a VM come up deserves better than a random extra retry.
step "Checking for work in flight"
RUNNING=""
if docker ps --format '{{.Names}}' | grep -q provisioning-temporal-1; then
  RUNNING="$(docker exec provisioning-temporal-1 temporal workflow list --address temporal:7233 2>/dev/null | grep -c ' Running ' || true)"
fi
if [ -n "$RUNNING" ] && [ "$RUNNING" -gt 0 ] 2>/dev/null; then
  if [ "$FORCE" -eq 1 ]; then
    warn "${RUNNING} workflow(s) running — continuing anyway (--force)"
  else
    die "${RUNNING} workflow(s) are running. Wait, or re-run with --force (costs them one retry attempt)."
  fi
else
  ok "Nothing in flight"
fi

# ── 2. Remember where we were ──────────────────────────────────────────────────────────────────
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
ok "Currently on ${PREVIOUS_COMMIT:0:12}"

# ── 3. Best-effort snapshot ────────────────────────────────────────────────────────────────────
# Insurance against the machine itself breaking. NOT used for rollback — see the header.
step "Taking a snapshot"
HCLOUD_TOKEN="${HCLOUD_TOKEN:-$(grep -E '^HCLOUD_TOKEN=' "$REPO_DIR/apps/backend/.env" 2>/dev/null | cut -d= -f2- || true)}"
if [ -n "$HCLOUD_TOKEN" ]; then
  # Hetzner's metadata service is link-local and only answers from the instance itself.
  SERVER_ID="$(curl -s -m 5 http://169.254.169.254/hetzner/v1/metadata/instance-id || true)"
  if [ -n "$SERVER_ID" ]; then
    if curl -sf -m 30 -X POST "https://api.hetzner.cloud/v1/servers/${SERVER_ID}/actions/create_image" \
        -H "Authorization: Bearer ${HCLOUD_TOKEN}" -H 'Content-Type: application/json' \
        -d "{\"type\":\"snapshot\",\"description\":\"pre-update ${PREVIOUS_COMMIT:0:12} $(date -u +%FT%TZ)\"}" \
        >/dev/null; then
      ok "Snapshot requested (restoring it would also roll back tenant data — see header)"
    else
      warn "Snapshot request failed — continuing"
    fi
  else
    warn "Not a Hetzner VM, or metadata unavailable — skipping snapshot"
  fi
else
  warn "No HCLOUD_TOKEN — skipping snapshot"
fi

# ── 4. Fetch and check out ─────────────────────────────────────────────────────────────────────
step "Fetching"
git fetch --all --tags --prune
REF="${TARGET_REF:-origin/main}"
# Detached on purpose, so a deploy pins an exact commit rather than tracking whatever a branch
# points at later — and so rolling back to a bare SHA works the same way as deploying a tag.
# Side effect: bootstrap.sh's `git pull --ff-only` no longer applies, which is why it only warns.
git checkout --detach "$REF" || die "Could not check out '${REF}'"
NEW_COMMIT="$(git rev-parse HEAD)"
if [ "$NEW_COMMIT" = "$PREVIOUS_COMMIT" ]; then
  ok "Already on ${NEW_COMMIT:0:12} — nothing to do"
  exit 0
fi
ok "Now on ${NEW_COMMIT:0:12} ($(git log -1 --format=%s | cut -c1-60))"

# ── 5. Build and verify BEFORE restarting ──────────────────────────────────────────────────────
# The point of ordering it this way: a build or type error should leave the running service
# untouched. Restarting first and discovering the problem afterwards means downtime for a fault we
# could have caught while the old version was still happily serving.
step "Building"
build_and_check() {
  npm ci --silent
  # Rebuilt every time, not just when the frontend changed: the backend serves this as static
  # files, so a stale build means a new API behind an old UI.
  npm run build --silent
  npm run typecheck --silent
}
if ! build_and_check; then
  warn "Build or typecheck failed — reverting to ${PREVIOUS_COMMIT:0:12}, service untouched"
  git checkout --detach "$PREVIOUS_COMMIT"
  npm ci --silent && npm run build --silent
  die "Update aborted before restart. The running version was never interrupted."
fi
ok "Build and typecheck clean"

# ── 6. Restart ─────────────────────────────────────────────────────────────────────────────────
# Restarts the backend AND both workers together, which is the entire point of doing it through
# the unit: the workers run plain `tsx` and do not hot-reload, so a deploy that only bounced the
# backend would leave them executing the previous release with nothing to warn you.
step "Restarting ${SERVICE}"
systemctl restart "$SERVICE"

# ── 7. Health check ────────────────────────────────────────────────────────────────────────────
# A 401 counts as healthy: /api is session-gated, so anything other than a connection failure
# proves the server is up and routing. Checking for 200 would fail on a perfectly good deploy.
step "Waiting for it to come back"
HEALTHY=0
for _ in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3001/api/clusters || echo 000)"
  if [ "$CODE" != "000" ]; then HEALTHY=1; break; fi
  sleep 2
done

if [ "$HEALTHY" -eq 1 ]; then
  ok "Backend responding"
else
  warn "Backend did not come back — rolling back to ${PREVIOUS_COMMIT:0:12}"
  git checkout --detach "$PREVIOUS_COMMIT"
  npm ci --silent && npm run build --silent
  systemctl restart "$SERVICE"
  die "Rolled back. Check: journalctl -u ${SERVICE} -n 100"
fi

# Both workers must be up, not just the backend. `concurrently --kill-others` means one dying takes
# the others with it, so a partial start shows up here rather than as activities that never run.
sleep 3
for w in worker-host worker-cluster; do
  pgrep -f "$w" >/dev/null || warn "${w} is not running — check journalctl -u ${SERVICE}"
done

echo
echo -e "${GREEN}Updated${NC} ${PREVIOUS_COMMIT:0:12} → ${NEW_COMMIT:0:12}"
echo "  Roll back with:  bash scripts/root-node/update.sh ${PREVIOUS_COMMIT:0:12}"
echo "  Logs:            journalctl -u ${SERVICE} -f"
