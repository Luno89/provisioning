#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/nowrinkles}"
ENV_FILE="$REPO_DIR/apps/backend/.env"
COMPOSE_ENV="$REPO_DIR/.env"
STAGE=/var/lib/koala-backup/stage
TAG=koala-root
HEADSCALE=provisioning-headscale
CADDY=nowrinkles-caddy
MAIL=nowrinkles-mail

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
ok()  { echo -e "  ${GREEN}✅${NC} $1"; }
die() { echo -e "  ${RED}❌${NC} $1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: this reads every store root keeps."
command -v restic >/dev/null || die "restic is not installed; bootstrap.sh installs it from Ubuntu's signed repository"

setting() { [ -f "$ENV_FILE" ] && grep "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
from_env() { local name="$1" value="${!1:-}"; [ -n "$value" ] && echo "$value" || setting "$name"; }

BACKUP_REPOSITORY="$(from_env BACKUP_REPOSITORY)"
[ -n "$BACKUP_REPOSITORY" ] || die "backups are off: set BACKUP_REPOSITORY (s3:https://<endpoint>/<bucket>), BACKUP_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in ${ENV_FILE}"
RESTIC_PASSWORD="$(from_env BACKUP_PASSWORD)"
[ -n "$RESTIC_PASSWORD" ] || die "BACKUP_PASSWORD is not set; restic encrypts every backup with it, and without it nothing can be restored"
export RESTIC_REPOSITORY="$BACKUP_REPOSITORY" RESTIC_PASSWORD
AWS_ACCESS_KEY_ID="$(from_env AWS_ACCESS_KEY_ID)"; AWS_SECRET_ACCESS_KEY="$(from_env AWS_SECRET_ACCESS_KEY)"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

if [ "${1:-backup}" = check ]; then
  restic check
  ok "the backup repository is whole"
  exit 0
fi

restic cat config >/dev/null 2>&1 || { restic init >/dev/null; ok "made the backup repository at ${BACKUP_REPOSITORY}"; }

container() { docker ps -a --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }
MONGO="$(container mongodb)"; [ -n "$MONGO" ] || die "Mongo's container is not here"
POSTGRES="$(container postgresql)"; [ -n "$POSTGRES" ] || die "Temporal's Postgres container is not here"
docker inspect "$HEADSCALE" >/dev/null 2>&1 || die "Headscale's container is not here"
docker inspect "$CADDY" >/dev/null 2>&1 || die "Caddy's container is not here"
MONGO_ROOT_PASSWORD="$(grep '^MONGO_ROOT_PASSWORD=' "$COMPOSE_ENV" | cut -d= -f2-)"
[ -n "$MONGO_ROOT_PASSWORD" ] || die "${COMPOSE_ENV} has no MONGO_ROOT_PASSWORD"

rm -rf "$STAGE"
install -d -m 700 "$STAGE"
restart_headscale() { docker start "$HEADSCALE" >/dev/null 2>&1 || true; }
trap restart_headscale EXIT

printf 'password: %s\n' "$MONGO_ROOT_PASSWORD" | docker exec -i "$MONGO" sh -c 'cat > /tmp/koala-backup.yaml && chmod 600 /tmp/koala-backup.yaml'
docker exec "$MONGO" sh -c 'mongodump --quiet --config /tmp/koala-backup.yaml --username admin --authenticationDatabase admin --archive --gzip --nsExclude "admin.*" --nsExclude "config.*" --nsExclude "local.*"; code=$?; rm -f /tmp/koala-backup.yaml; exit $code' > "$STAGE/mongo.archive.gz"
ok "Mongo dumped ($(du -h "$STAGE/mongo.archive.gz" | cut -f1))"

for db in temporal temporal_visibility; do
  docker exec "$POSTGRES" pg_dump -U temporal -Fc "$db" > "$STAGE/$db.pgdump"
done
ok "Temporal's databases dumped"

docker stop "$HEADSCALE" >/dev/null
docker cp "$HEADSCALE:/var/lib/headscale" - > "$STAGE/headscale.tar"
docker start "$HEADSCALE" >/dev/null
ok "Headscale's database and noise key copied while it was stopped"

docker cp "$CADDY:/data" - > "$STAGE/caddy-data.tar"
ok "Caddy's certificates and keys copied"

if docker inspect "$MAIL" >/dev/null 2>&1; then
  docker cp "$MAIL:/var/lib/dkim" - > "$STAGE/dkim.tar"
  ok "the mail server's DKIM key copied, so the published DKIM record stays true"
fi

PATHS=("$STAGE" "$REPO_DIR/.env" "$ENV_FILE" "$REPO_DIR/apps/backend/data")
[ -d /var/lib/tailscale ] && PATHS+=(/var/lib/tailscale)
restic backup --quiet --host "$TAG" --tag "$TAG" --exclude "$REPO_DIR/apps/backend/data/logs" "${PATHS[@]}"
SNAPSHOT="$(restic snapshots --tag "$TAG" --latest 1 --json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const x=JSON.parse(s).at(-1);console.log(`${x.short_id} at ${x.time}`)})')"
ok "backed up to ${BACKUP_REPOSITORY}: snapshot ${SNAPSHOT}"

restic forget --quiet --tag "$TAG" --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
rm -rf "$STAGE"
ok "kept 14 daily, 8 weekly and 12 monthly backups"
