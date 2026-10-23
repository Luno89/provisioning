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
REGISTRY="${REGISTRY:-127.0.0.1:5000}"
IMAGE_REPO="nowrinkles/app"
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
BACKEND_ENV="apps/backend/.env"

set_backend_env() {
  if grep -q "^$1=" "$BACKEND_ENV"; then
    sed -i "s|^$1=.*|$1=$2|" "$BACKEND_ENV"
  else
    echo "$1=$2" >> "$BACKEND_ENV"
  fi
}

published() {
  curl -fsS "http://${REGISTRY}/v2/${IMAGE_REPO}/tags/list" 2>/dev/null | grep -q "\"$1\""
}

ensure_cdktf_bindings() {
  local infra="$REPO_DIR/packages/cdktf-infra" missing=() provider name work
  while IFS= read -r provider; do
    name="${provider%@*}"; name="${name##*/}"
    [ -d "$infra/.gen/providers/$name" ] || missing+=("$provider")
  done < <(node -e 'for (const p of require(process.argv[1]).terraformProviders) console.log(p)' "$infra/cdktf.json")
  [ "${#missing[@]}" -eq 0 ] && return 0
  warn "the checkout has no CDKTF bindings for ${missing[*]}; generating them"
  work="$(mktemp -d "$infra/.gen-missing-XXXXXX")"
  node -e 'console.log(JSON.stringify({ language: "typescript", app: "true", projectId: "cdktf-infra", sendCrashReports: "false", terraformProviders: process.argv.slice(1) }))' "${missing[@]}" > "$work/cdktf.json"
  (cd "$work" && TERRAFORM_BINARY_NAME="$REPO_DIR/bin/terraform" npx cdktf get --output .gen >/dev/null) || { rm -rf "$work"; return 1; }
  mkdir -p "$infra/.gen/providers"
  cp -r "$work/.gen/providers/." "$infra/.gen/providers/"
  rm -rf "$work"
  ok "CDKTF bindings generated for ${missing[*]}"
}

# ── 1. Don't interrupt a tenant ────────────────────────────────────────────────────────────────
# A restart mid-provision is survivable — Temporal keeps workflow state, so the activity resumes on
# the new process rather than losing the cluster. But it does burn one of ProvisionClusterActivity's
# three attempts, and a tenant watching a VM come up deserves better than a random extra retry.
step "Checking for work in flight"
TEMPORAL="$(docker ps --filter label=com.docker.compose.service=temporal --format '{{.Names}}' | head -1)"
if [ -z "$TEMPORAL" ]; then
  warn "No Temporal container is running, so nothing can be in flight"
else
  LISTED="$(docker exec "$TEMPORAL" temporal workflow list --address temporal:7233 --query 'ExecutionStatus="Running"' 2>&1)" || die "Could not list the workflows in flight: ${LISTED}"
  RUNNING="$(printf '%s\n' "$LISTED" | grep -c ' Running ' || true)"
  if [ "$RUNNING" -gt 0 ]; then
    if [ "$FORCE" -eq 1 ]; then
      warn "${RUNNING} workflow(s) running — continuing anyway (--force)"
    else
      die "${RUNNING} workflow(s) are running. Wait, or re-run with --force (costs them one retry attempt)."
    fi
  else
    ok "Nothing in flight"
  fi
fi

# ── 2. Remember where we were ──────────────────────────────────────────────────────────────────
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
PREVIOUS_TAG="$(grep -E '^INSTANCE_IMAGE_TAG=' "$BACKEND_ENV" 2>/dev/null | cut -d= -f2- || true)"
ok "Currently on ${PREVIOUS_COMMIT:0:12}${PREVIOUS_TAG:+, instances on ${PREVIOUS_TAG}}"

publish_image() {
  step "Publishing the instance image"
  local tag="$1" image="${REGISTRY}/${IMAGE_REPO}:$1"
  if published "$tag"; then
    ok "the registry already holds ${image}"
  else
    local cache=()
    if [ -n "$PREVIOUS_TAG" ] && published "$PREVIOUS_TAG"; then cache=(--cache-from "${REGISTRY}/${IMAGE_REPO}:${PREVIOUS_TAG}"); fi
    DOCKER_BUILDKIT=1 docker build -q --build-arg BUILDKIT_INLINE_CACHE=1 "${cache[@]}" -t "$image" . >/dev/null || return 1
    docker push -q "$image" >/dev/null || return 1
    ok "built and pushed ${image}"
  fi
  set_backend_env INSTANCE_IMAGE_TAG "$tag"
  ok "instances move to ${tag} the next time they check in (hourly)"
}

# A 401 counts as healthy: /api is session-gated, so anything other than a connection failure
# proves the server is up and routing. Checking for 200 would fail on a perfectly good deploy.
wait_for_backend() {
  local restarts waited=0
  restarts="$(systemctl show -p NRestarts --value "$SERVICE")"
  while :; do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3001/api/clusters || echo 000)"
    [ "$CODE" != "000" ] && return 0
    systemctl is-active --quiet "$SERVICE" || return 1
    [ "$(systemctl show -p NRestarts --value "$SERVICE")" = "$restarts" ] || return 1
    waited=$((waited + 2))
    [ $((waited % 30)) -eq 0 ] && echo "  still waiting for the backend (${waited}s)"
    sleep 2
  done
}

restart_and_check() {
  step "Restarting ${SERVICE}"
  systemctl restart "$SERVICE"
  step "Waiting for it to come back"
  if wait_for_backend; then
    ok "Backend responding"
    return 0
  fi
  return 1
}

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
git clean -fdqX packages/cdktf-infra/.gen
git checkout --detach "$REF" || die "Could not check out '${REF}'"
ensure_cdktf_bindings || die "Could not generate the CDKTF bindings this commit needs"
NEW_COMMIT="$(git rev-parse HEAD)"
RELEASE_TAG="$(git rev-parse --short=12 HEAD)"
if [ "$NEW_COMMIT" = "$PREVIOUS_COMMIT" ]; then
  ok "Already on ${NEW_COMMIT:0:12}"
  if published "$RELEASE_TAG" && [ "$PREVIOUS_TAG" = "$RELEASE_TAG" ]; then
    ok "and its image is published — nothing to do"
    exit 0
  fi
  publish_image "$RELEASE_TAG" || die "Could not build or push the instance image"
  if systemctl is-active --quiet "$SERVICE"; then
    restart_and_check || die "The backend did not come back after restarting with INSTANCE_IMAGE_TAG=${RELEASE_TAG}. Check: journalctl -u ${SERVICE} -n 100"
  else
    ok "${SERVICE} is not running; it serves ${RELEASE_TAG} once started"
  fi
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
  # Errors only, and only in files not on the LEGACY list in eslint.config.js — so this catches a
  # new violation without a pile of known debt blocking a deploy.
  #
  # The unit suites are deliberately NOT here. They take ~57s, and this gate auto-reverts to the
  # previous commit on failure: one flaky test would silently roll back a production deploy, which
  # is a far worse outcome than a test failure nobody noticed. CI (.github/workflows/ci.yml) runs
  # them on the push, which is the right place — it can be red without reverting anything.
  npm run lint --silent
}
if ! build_and_check; then
  warn "Build, typecheck or lint failed — reverting to ${PREVIOUS_COMMIT:0:12}, service untouched"
  git clean -fdqX packages/cdktf-infra/.gen
  git checkout --detach "$PREVIOUS_COMMIT"
  ensure_cdktf_bindings
  npm ci --silent && npm run build --silent
  die "Update aborted before restart. The running version was never interrupted."
fi
ok "Build, typecheck and lint clean"

publish_image "$RELEASE_TAG" || warn "could not build or push the instance image — instances stay on the version they run"

# A release that adds a tool, persona or pack has to put it in the database, and nothing does that
# at server start any more. Before the restart, so the new version never comes up against a
# catalogue missing what it expects. Idempotent — writes nothing when the release changed none.
step "Seeding catalogues"
npx tsx apps/backend/src/scripts/seed-all.ts || warn "seed failed — the new version may be missing catalogue entries"

# ── 6. Restart ─────────────────────────────────────────────────────────────────────────────────
# Restarts the backend AND both workers together, which is the entire point of doing it through
# the unit: the workers run plain `tsx` and do not hot-reload, so a deploy that only bounced the
# backend would leave them executing the previous release with nothing to warn you.
step "Restarting ${SERVICE}"
systemctl restart "$SERVICE"

step "Updating Caddy"
docker compose -f docker-compose.caddy.yml up -d --build
docker exec nowrinkles-caddy caddy reload --config /etc/caddy/Caddyfile --force || warn "Caddy did not take the new Caddyfile: docker logs nowrinkles-caddy"

step "Updating the mail server"
docker compose -f docker-compose.mail.yml up -d --build

step "Updating Koala's telemetry collector"
OTEL_IP="$("$REPO_DIR/bin/kubectl" --context k3d-provisioning-lunorica -n monitoring get svc otel-collector -o 'jsonpath={.spec.clusterIP}' 2>/dev/null || true)"
if [ -n "$OTEL_IP" ] && [ "$OTEL_IP" != "None" ]; then
  grep -q '^OTEL_CLUSTER_COLLECTOR=' .env && sed -i "s|^OTEL_CLUSTER_COLLECTOR=.*|OTEL_CLUSTER_COLLECTOR=${OTEL_IP}:4317|" .env || echo "OTEL_CLUSTER_COLLECTOR=${OTEL_IP}:4317" >> .env
  docker compose -f docker-compose.otel.yml up -d
  grep -q '^OTEL_EXPORTER_OTLP_ENDPOINT=' apps/backend/.env || echo "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318" >> apps/backend/.env
  ok "the host collector relays to the cluster's collector at ${OTEL_IP}"
else
  warn "the cluster has no collector yet; the cluster worker installs it on start, and the next update.sh starts the host collector"
fi

# ── 7. Health check ────────────────────────────────────────────────────────────────────────────
step "Waiting for it to come back"
if wait_for_backend; then
  ok "Backend responding"
else
  warn "Backend did not come back — rolling back to ${PREVIOUS_COMMIT:0:12}"
  git clean -fdqX packages/cdktf-infra/.gen
  git checkout --detach "$PREVIOUS_COMMIT"
  ensure_cdktf_bindings
  npm ci --silent && npm run build --silent
  [ -n "$PREVIOUS_TAG" ] && set_backend_env INSTANCE_IMAGE_TAG "$PREVIOUS_TAG"
  systemctl restart "$SERVICE"
  die "Rolled back${PREVIOUS_TAG:+, instances stay on ${PREVIOUS_TAG}}. Check: journalctl -u ${SERVICE} -n 100"
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
