#!/usr/bin/env bash
# update.sh — Deploy a new version of the platform onto the root node.
#
# Usage (on the root node, as root):
#   bash scripts/root-node/update.sh v2026.10.25        # a release tag signed by a key in /etc/koala/release-signers
#   bash scripts/root-node/update.sh v2026.10.25 --force  # update despite work in flight
#   (a lab, ROOT_TLS=internal, also takes any git ref, and origin/main when none is given)
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
PUBLISHED_IMAGE="${PUBLISHED_IMAGE-ghcr.io/luno89/nowrinkles/app}"
SIGNERS="${RELEASE_SIGNERS:-/etc/koala/release-signers}"
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
LAB=0
grep -q '^ROOT_TLS=internal$' .env 2>/dev/null && LAB=1

set_backend_env() {
  if grep -q "^$1=" "$BACKEND_ENV"; then
    sed -i "s|^$1=.*|$1=$2|" "$BACKEND_ENV"
  else
    echo "$1=$2" >> "$BACKEND_ENV"
  fi
}

install_units() {
  if [ -f scripts/root-node/units.sh ]; then
    REPO_DIR="$REPO_DIR" bash scripts/root-node/units.sh
    return
  fi
  systemctl disable --now nowrinkles-workers.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/nowrinkles-workers.service
  cat > /etc/systemd/system/nowrinkles.service <<UNIT
[Unit]
Description=No Wrinkles platform
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  ok "this release runs the backend and its workers in one unit, as root"
}

published() {
  curl -fsS "http://${REGISTRY}/v2/${IMAGE_REPO}/tags/list" 2>/dev/null | grep -q "\"$1\""
}

BINDINGS="$(mktemp)"
VERIFY="$(mktemp)"
trap 'rm -f "$BINDINGS" "$VERIFY"' EXIT
cp "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/cdktf-bindings.sh" "$BINDINGS" || die "cdktf-bindings.sh must sit beside update.sh"
cp "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/verify-release.sh" "$VERIFY" || die "verify-release.sh must sit beside update.sh"

install_dependencies() {
  npm ci --ignore-scripts --silent && node scripts/fix-dnd-kit-hoisting.js
}

registry_digest() {
  curl -fsSI \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://${REGISTRY}/v2/${IMAGE_REPO}/manifests/$1" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p'
}

ensure_cdktf_bindings() {
  bash "$BINDINGS" "$REPO_DIR"
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
PREVIOUS_DIGEST="$(grep -E '^INSTANCE_IMAGE_DIGEST=' "$BACKEND_ENV" 2>/dev/null | cut -d= -f2- || true)"
PREVIOUS_RELEASE="$(git describe --exact-match --tags --match 'v*' HEAD 2>/dev/null || true)"
ok "Currently on ${PREVIOUS_COMMIT:0:12}${PREVIOUS_TAG:+, instances on ${PREVIOUS_TAG}}"

publish_image() {
  step "Publishing the instance image"
  local tag="$1" image="${REGISTRY}/${IMAGE_REPO}:$1"
  if published "$tag"; then
    ok "the registry already holds ${image}"
  elif [ "$LAB" -eq 0 ]; then
    [ -n "$RELEASE_NAME" ] || { warn "only a signed release's image goes to instances, and ${REF} is not one"; return 1; }
    local verified
    verified="$(COSIGN="${COSIGN:-/usr/local/bin/cosign}" PUBLISHED_IMAGE="$PUBLISHED_IMAGE" bash "$VERIFY" image "$RELEASE_NAME" "$NEW_COMMIT")" || return 1
    docker tag "$verified" "$image"
    docker push -q "$image" >/dev/null || return 1
    ok "${verified} is attested as built by release.yml from ${NEW_COMMIT:0:12} at ${RELEASE_NAME}; pushed as ${image}"
  elif [ -n "$PUBLISHED_IMAGE" ] && docker pull -q "${PUBLISHED_IMAGE}:${tag}" >/dev/null 2>&1; then
    docker tag "${PUBLISHED_IMAGE}:${tag}" "$image"
    docker push -q "$image" >/dev/null || return 1
    ok "pulled ${PUBLISHED_IMAGE}:${tag}, the image the Release workflow published, into ${image}"
  else
    local cache=()
    if [ -n "$PREVIOUS_TAG" ] && published "$PREVIOUS_TAG"; then cache=(--cache-from "${REGISTRY}/${IMAGE_REPO}:${PREVIOUS_TAG}"); fi
    DOCKER_BUILDKIT=1 docker build -q --build-arg BUILDKIT_INLINE_CACHE=1 "${cache[@]}" -t "$image" . >/dev/null || return 1
    docker push -q "$image" >/dev/null || return 1
    ok "built and pushed ${image}${PUBLISHED_IMAGE:+ (${PUBLISHED_IMAGE} has no ${tag})}"
  fi
  local digest
  digest="$(registry_digest "$tag")"
  [ -n "$digest" ] || { warn "the registry gives no digest for ${image}"; return 1; }
  set_backend_env INSTANCE_IMAGE_TAG "$tag"
  set_backend_env INSTANCE_IMAGE_DIGEST "$digest"
  ok "instances move to ${tag} (${digest}) the next time they check in (hourly), and refuse any other image under that name"
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
  ok "No snapshot step for this provider; its own backups (OVH's backup option) keep the disaster copy"
fi

# ── 4. Fetch and check out ─────────────────────────────────────────────────────────────────────
step "Fetching"
git fetch --all --tags --prune
REF="${TARGET_REF:-origin/main}"
RELEASE_NAME=""
if git rev-parse -q --verify "refs/tags/${REF}" >/dev/null; then
  if [ "$LAB" -eq 0 ] || [ -s "$SIGNERS" ]; then
    bash "$VERIFY" tag "$REPO_DIR" "$REF" >/dev/null || die "Refusing ${REF}: root moves only onto a release signed by a key in ${SIGNERS}"
    ok "${REF} is signed by a release key root trusts"
  fi
  RELEASE_NAME="$REF"
elif [ "$LAB" -eq 0 ]; then
  die "Refusing ${REF}: root moves only onto a signed release tag. Name one (bash scripts/root-node/release-watch.sh <tag>), or roll back with update.sh <the tag it ran before>."
fi
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

step "Keeping the host's settings"
if [ -f scripts/root-node/harden-host.sh ]; then
  LAB="$LAB" bash scripts/root-node/harden-host.sh
else
  warn "this release predates harden-host.sh, so the host keeps the settings it has"
fi

# ── 5. Build and verify BEFORE restarting ──────────────────────────────────────────────────────
# The point of ordering it this way: a build or type error should leave the running service
# untouched. Restarting first and discovering the problem afterwards means downtime for a fault we
# could have caught while the old version was still happily serving.
step "Building"
build_and_check() {
  install_dependencies
  # Rebuilt every time, not just when the frontend changed: the backend serves this as static
  # files, so a stale build means a new API behind an old UI.
  npm run build --silent
  npm run typecheck --silent
  # Errors only, and only in files not on the LEGACY list in eslint.config.js — so this catches a
  # new violation without a pile of known debt blocking a deploy.
  #
  # The unit suites are deliberately NOT here. They take ~57s, and this gate auto-reverts to the
  # previous commit on failure: one flaky test would silently roll back a production deploy, which
  # is a far worse outcome than a test failure nobody noticed. `npm run ship` runs
  # them before the commit reaches main, which is the right place — it can fail without reverting anything.
  npm run lint --silent
}
if ! build_and_check; then
  warn "Build, typecheck or lint failed — reverting to ${PREVIOUS_COMMIT:0:12}, service untouched"
  git clean -fdqX packages/cdktf-infra/.gen
  git checkout --detach "$PREVIOUS_COMMIT"
  ensure_cdktf_bindings
  install_dependencies && npm run build --silent
  die "Update aborted before restart. The running version was never interrupted."
fi
ok "Build, typecheck and lint clean"

if ! publish_image "$RELEASE_TAG"; then
  if [ "$LAB" -eq 0 ]; then
    warn "the release's image could not be verified — reverting to ${PREVIOUS_COMMIT:0:12}, service untouched"
    git clean -fdqX packages/cdktf-infra/.gen
    git checkout --detach "$PREVIOUS_COMMIT"
    ensure_cdktf_bindings
    install_dependencies && npm run build --silent
    die "Update aborted before restart: root runs a release only with the image GitHub attested for it."
  fi
  warn "could not build or push the instance image — instances stay on the version they run"
fi

# A release that adds a tool, persona or pack has to put it in the database, and nothing does that
# at server start any more. Before the restart, so the new version never comes up against a
# catalogue missing what it expects. Idempotent — writes nothing when the release changed none.
step "Seeding catalogues"
npx tsx apps/backend/src/scripts/seed-all.ts || warn "seed failed — the new version may be missing catalogue entries"

# ── 6. Restart ─────────────────────────────────────────────────────────────────────────────────
# Restarts the backend AND both workers together, which is the entire point of doing it through
# the unit: the workers run plain `tsx` and do not hot-reload, so a deploy that only bounced the
# backend would leave them executing the previous release with nothing to warn you.
step "Installing this release's units"
install_units

step "Updating Caddy"
docker compose -f docker-compose.caddy.yml up -d --build
while ! said="$(docker exec nowrinkles-caddy caddy reload --config /etc/caddy/Caddyfile --force 2>&1)"; do
  case "$said" in
    *"connection refused"*|*"no such file or directory"*) sleep 1 ;;
    *) warn "Caddy did not take the new Caddyfile: $(printf '%s' "$said" | tail -n1)"; break ;;
  esac
done

step "Restarting ${SERVICE}"
systemctl restart "$SERVICE"

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
  install_dependencies && npm run build --silent
  install_units
  docker compose -f docker-compose.caddy.yml up -d --build
  [ -n "$PREVIOUS_TAG" ] && set_backend_env INSTANCE_IMAGE_TAG "$PREVIOUS_TAG"
  [ -n "$PREVIOUS_DIGEST" ] && set_backend_env INSTANCE_IMAGE_DIGEST "$PREVIOUS_DIGEST"
  systemctl restart "$SERVICE"
  die "Rolled back${PREVIOUS_TAG:+, instances stay on ${PREVIOUS_TAG}}. Check: journalctl -u ${SERVICE} -n 100"
fi

# Both workers must be up, not just the backend. `concurrently --kill-others` means one dying takes
# the others with it, so a partial start shows up here rather than as activities that never run.
sleep 3
for w in worker-host worker-cluster; do
  pgrep -f "$w" >/dev/null || warn "${w} is not running — check journalctl -u ${SERVICE}-workers -u ${SERVICE}"
done

echo
echo -e "${GREEN}Updated${NC} ${PREVIOUS_COMMIT:0:12} → ${NEW_COMMIT:0:12}"
echo "  Roll back with:  bash scripts/root-node/update.sh ${PREVIOUS_RELEASE:-${PREVIOUS_COMMIT:0:12}}"
echo "  Logs:            journalctl -u ${SERVICE} -f"
