#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/nowrinkles}"
ENV_FILE="$REPO_DIR/apps/backend/.env"
COMPOSE_ENV="$REPO_DIR/.env"
DATA_DIR="$REPO_DIR/apps/backend/data"
STAGE=/var/lib/koala-backup/stage
RESTORED=/var/lib/koala-backup/restored
TAG=koala-root
HEADSCALE=provisioning-headscale
CADDY=nowrinkles-caddy
MAIL=nowrinkles-mail
K3S_UNIT=/etc/systemd/system/k3s-provisioning-lunorica.service

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
die()  { echo -e "  ${RED}❌${NC} $1" >&2; exit 1; }

SNAPSHOT="${1:-}"
[ -n "$SNAPSHOT" ] || die "usage: restore.sh <snapshot id | latest>  (list them with: restic snapshots)"
[ "$(id -u)" -eq 0 ] || die "Run as root: this replaces every store root keeps."
command -v restic >/dev/null || die "restic is not installed; bootstrap.sh installs it"
[ -f "$ENV_FILE" ] && [ -f "$COMPOSE_ENV" ] || die "bootstrap.sh has not run here; a restore goes onto a freshly bootstrapped root"

setting() { grep "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
from_env() { local value="${!1:-}"; [ -n "$value" ] && echo "$value" || setting "$1" "$ENV_FILE"; }
put() { local key="$1" value="$2" file="$3"; if grep -q "^${key}=" "$file"; then sed -i "s|^${key}=.*|${key}=${value}|" "$file"; else echo "${key}=${value}" >> "$file"; fi; }

RESTIC_REPOSITORY="$(from_env BACKUP_REPOSITORY)"
[ -n "$RESTIC_REPOSITORY" ] || die "set BACKUP_REPOSITORY, BACKUP_PASSWORD, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (here or in ${ENV_FILE}) to the repository to restore from"
RESTIC_PASSWORD="$(from_env BACKUP_PASSWORD)"
[ -n "$RESTIC_PASSWORD" ] || die "BACKUP_PASSWORD is not set; without it the backup cannot be read"
AWS_ACCESS_KEY_ID="$(from_env AWS_ACCESS_KEY_ID)"; AWS_SECRET_ACCESS_KEY="$(from_env AWS_SECRET_ACCESS_KEY)"
export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

container() { docker ps -a --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }
MONGO="$(container mongodb)"; [ -n "$MONGO" ] || die "Mongo's container is not here"
POSTGRES="$(container postgresql)"; [ -n "$POSTGRES" ] || die "Temporal's Postgres container is not here"
TEMPORAL="$(container temporal)"; [ -n "$TEMPORAL" ] || die "Temporal's container is not here"

rm -rf "$RESTORED"
install -d -m 700 "$RESTORED"
if [ "$SNAPSHOT" = latest ]; then restic restore latest --tag "$TAG" --target "$RESTORED" >/dev/null
else restic restore "$SNAPSHOT" --target "$RESTORED" >/dev/null; fi
FROM="$RESTORED$STAGE"
for piece in mongo.archive.gz temporal.pgdump temporal_visibility.pgdump headscale.tar caddy-data.tar; do
  [ -s "$FROM/$piece" ] || die "the backup has no ${piece}; nothing was changed"
done
[ -f "$RESTORED$ENV_FILE" ] && [ -f "$RESTORED$COMPOSE_ENV" ] || die "the backup has no env files; nothing was changed"
ok "snapshot ${SNAPSHOT} read from ${RESTIC_REPOSITORY}"

FRESH_MONGO_PASSWORD="$(setting MONGO_ROOT_PASSWORD "$COMPOSE_ENV")"
FRESH_MONGO_URI="$(setting MONGO_URI "$ENV_FILE")"
FRESH_OTEL="$(setting OTEL_CLUSTER_COLLECTOR "$COMPOSE_ENV")"
FRESH_SLOTS="$(setting POOL_SLOTS "$ENV_FILE")"
FRESH_MESH_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
OURS=(BACKUP_REPOSITORY BACKUP_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY)
declare -A KEEP
for key in "${OURS[@]}"; do KEEP[$key]="$(from_env "$key")"; done

systemctl stop nowrinkles.service nowrinkles-workers.service 2>/dev/null || true
ok "Koala stopped"

cp "$RESTORED$COMPOSE_ENV" "$COMPOSE_ENV"
cp "$RESTORED$ENV_FILE" "$ENV_FILE"
put MONGO_ROOT_PASSWORD "$FRESH_MONGO_PASSWORD" "$COMPOSE_ENV"
put MONGO_URI "$FRESH_MONGO_URI" "$ENV_FILE"
[ -n "$FRESH_OTEL" ] && put OTEL_CLUSTER_COLLECTOR "$FRESH_OTEL" "$COMPOSE_ENV"
[ -n "$FRESH_SLOTS" ] && put POOL_SLOTS "$FRESH_SLOTS" "$ENV_FILE"
for key in "${OURS[@]}"; do [ -n "${KEEP[$key]}" ] && put "$key" "${KEEP[$key]}" "$ENV_FILE"; done
find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name logs -exec rm -rf {} +
cp -a "$RESTORED$DATA_DIR/." "$DATA_DIR/"
ok "env and data restored, keeping this host's own Mongo password, collector address and trial slots"

docker stop "$CADDY" >/dev/null
docker cp - "$CADDY:/" < "$FROM/caddy-data.tar"
docker start "$CADDY" >/dev/null
if [ "$(setting ROOT_TLS "$COMPOSE_ENV")" = internal ]; then
  docker cp "$CADDY:/data/caddy/pki/authorities/local/root.crt" /usr/local/share/ca-certificates/koala-lab.crt
  update-ca-certificates >/dev/null
  ok "Caddy's certificates restored, and this lab host trusts the restored authority"
else
  ok "Caddy's certificates restored"
fi

if [ -s "$FROM/dkim.tar" ] && docker inspect "$MAIL" >/dev/null 2>&1; then
  docker stop "$MAIL" >/dev/null
  docker cp - "$MAIL:/var/lib" < "$FROM/dkim.tar"
  docker start "$MAIL" >/dev/null
  ok "the mail server signs with the DKIM key its DNS record publishes"
fi

docker stop "$HEADSCALE" >/dev/null
docker cp - "$HEADSCALE:/var/lib" < "$FROM/headscale.tar"
docker start "$HEADSCALE" >/dev/null
ok "Headscale's database and noise key restored"

printf 'password: %s\n' "$FRESH_MONGO_PASSWORD" | docker exec -i "$MONGO" sh -c 'cat > /tmp/koala-restore.yaml && chmod 600 /tmp/koala-restore.yaml'
docker exec -i "$MONGO" sh -c 'mongorestore --quiet --config /tmp/koala-restore.yaml --username admin --authenticationDatabase admin --drop --archive --gzip; code=$?; rm -f /tmp/koala-restore.yaml; exit $code' < "$FROM/mongo.archive.gz"
ok "Mongo restored"

docker stop "$TEMPORAL" >/dev/null
for db in temporal temporal_visibility; do
  docker exec -i "$POSTGRES" pg_restore -U temporal --clean --if-exists --no-owner -d "$db" < "$FROM/$db.pgdump"
done
docker start "$TEMPORAL" >/dev/null
ok "Temporal's databases restored"

if [ -d "$RESTORED/var/lib/tailscale" ]; then
  systemctl stop tailscaled
  rm -rf /var/lib/tailscale
  cp -a "$RESTORED/var/lib/tailscale" /var/lib/tailscale
  systemctl start tailscaled
  MESH_IP=""
  for _ in $(seq 1 60); do MESH_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"; [ -n "$MESH_IP" ] && tailscale status >/dev/null 2>&1 && break; sleep 2; done
  [ -n "$MESH_IP" ] || die "this host did not come back on the mesh as the old root; check Headscale and tailscaled"
  ok "this host is the old root on the mesh again, at ${MESH_IP}"
  if [ -n "$FRESH_MESH_IP" ] && [ "$FRESH_MESH_IP" != "$MESH_IP" ] && [ -f "$K3S_UNIT" ]; then
    sed -i "s|${FRESH_MESH_IP}/32|${MESH_IP}/32|g" "$K3S_UNIT"
    systemctl daemon-reload
    systemctl restart "$(basename "$K3S_UNIT")"
    ok "k3s serves its node ports on ${MESH_IP} again"
  fi
  (cd "$REPO_DIR" && docker compose -f docker-compose.registry.yml up -d >/dev/null)
else
  warn "the backup holds no mesh identity for this host; run bootstrap.sh again to join the mesh as a new node"
fi

REPO_DIR="$REPO_DIR" bash "$REPO_DIR/scripts/root-node/units.sh" >/dev/null
systemctl start nowrinkles.service nowrinkles-workers.service
rm -rf "$RESTORED"
ok "Koala started on what snapshot ${SNAPSHOT} held"
echo
echo "Next: publish the instance image again, which the restored registry does not hold:"
echo "  bash ${REPO_DIR}/scripts/root-node/update.sh   (a lab)   or   bash ${REPO_DIR}/scripts/root-node/release-watch.sh"
