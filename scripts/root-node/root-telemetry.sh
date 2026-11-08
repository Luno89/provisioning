#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/nowrinkles}"
COMPOSE_ENV="${COMPOSE_ENV:-$REPO_DIR/.env}"
BACKEND_ENV="${BACKEND_ENV:-$REPO_DIR/apps/backend/.env}"
KUBECTL="${KUBECTL:-$REPO_DIR/bin/kubectl}"
ADMIN_KUBECONFIG="${ADMIN_KUBECONFIG:-/var/lib/rancher/k3s-provisioning-lunorica/kubeconfig.yaml}"
CONTEXT=k3d-provisioning-lunorica
METRICS_DIR="${METRICS_DIR:-/var/lib/koala-backup/metrics}"
METRIC_PORTS="4317 4318 9216 9187 9233 9090 5005 5006"
MONGO_USER=koala-metrics
POSTGRES_ROLE=koala_metrics

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
die()  { echo -e "  ${RED}❌${NC} $1" >&2; exit 1; }

put() {
  local key="$1" value="$2" file="$3"
  if grep -q "^${key}=" "$file"; then sed -i "s|^${key}=.*|${key}=${value}|" "$file"; else echo "${key}=${value}" >> "$file"; fi
}

setting() {
  grep "^$1=" "$2" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

kept_secret() {
  local key="$1" file="$2"
  grep -qE "^${key}=[0-9a-f]{48}$" "$file" || put "$key" "$(openssl rand -hex 24)" "$file"
  chmod 600 "$file"
  setting "$key" "$file"
}

container() { docker ps --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }

mongo_monitor() {
  local mongo="$1" root_password="$2" password="$3" said
  said="$(printf '%s\n' \
    "const admin = db.getSiblingDB('admin');" \
    "admin.auth('admin', '${root_password}');" \
    "if (!admin.hello().isWritablePrimary) { print('KOALA-NOT-PRIMARY'); quit(3); }" \
    "const roles = [{ role: 'clusterMonitor', db: 'admin' }, { role: 'read', db: 'local' }];" \
    "if (admin.getUser('${MONGO_USER}')) admin.updateUser('${MONGO_USER}', { pwd: '${password}', roles }); else admin.createUser({ user: '${MONGO_USER}', pwd: '${password}', roles });" \
    "print('KOALA-MONITOR-READY');" \
    | docker exec -i "$mongo" mongosh --quiet 'mongodb://127.0.0.1:27017/admin?directConnection=true' 2>&1)" || true
  case "$said" in
    *KOALA-MONITOR-READY*) return 0 ;;
    *KOALA-NOT-PRIMARY*) die "Mongo is not its replica set's primary yet, so it cannot be given a monitoring user; the backend or seed-all.ts makes it one when it first connects. Run this again once it has." ;;
    *) die "Mongo refused to make its monitoring user: $(printf '%s\n' "$said" | grep -v -e "${password}" -e "${root_password}" | tail -n1)" ;;
  esac
}

postgres_monitor() {
  local postgres="$1" password="$2"
  printf '%s\n' \
    "SELECT 'CREATE ROLE ${POSTGRES_ROLE} LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_ROLE}')\\gexec" \
    "ALTER ROLE ${POSTGRES_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}';" \
    "GRANT pg_monitor TO ${POSTGRES_ROLE};" \
    | docker exec -i "$postgres" psql -q -v ON_ERROR_STOP=1 -U temporal -d postgres >/dev/null 2>&1 \
    || die "Temporal's Postgres refused to make its monitoring role ${POSTGRES_ROLE}"
}

collector_address() {
  local said waited=0
  until "$KUBECTL" --context "$CONTEXT" -n monitoring get deployment otel-collector >/dev/null 2>&1; do
    if [ $((waited % 60)) -eq 0 ]; then echo "  waiting for the cluster's collector (deployment otel-collector in monitoring on ${CONTEXT}) to be made" >&2; fi
    waited=$((waited + 5))
    sleep 5
  done
  echo "  waiting for the cluster's collector to roll out" >&2
  said="$("$KUBECTL" --context "$CONTEXT" -n monitoring rollout status deployment/otel-collector 2>&1)" \
    || die "the cluster's collector cannot roll out: $(printf '%s' "$said" | tail -n1). Check: ${KUBECTL} --context ${CONTEXT} -n monitoring describe deployment otel-collector"
  "$KUBECTL" --context "$CONTEXT" -n monitoring get svc otel-collector -o 'jsonpath={.spec.clusterIP}'
}

loopback_only() {
  local port listening
  for port in $METRIC_PORTS; do
    listening="$(ss -ltnH "( sport = :${port} )" | awk '{print $4}')"
    [ -n "$listening" ] || continue
    if printf '%s\n' "$listening" | grep -qv '^127\.0\.0\.1:'; then
      die "port ${port} is listening beyond 127.0.0.1 ($(printf '%s' "$listening" | paste -sd' ' -)); every metrics port on root answers on loopback only"
    fi
  done
}

main() {
  [ "$(id -u)" -eq 0 ] || die "Run as root: this writes root's env files and starts its containers."
  cd "$REPO_DIR"
  [ -f "$COMPOSE_ENV" ] || die "${COMPOSE_ENV} is missing; bootstrap.sh makes it"
  [ -f "$BACKEND_ENV" ] || die "${BACKEND_ENV} is missing; bootstrap.sh makes it"

  bash scripts/root-node/cdktf-bindings.sh "$REPO_DIR" || die "the CDKTF bindings the cluster's monitoring needs could not be generated"
  ROOT_KUBECONFIG="$ADMIN_KUBECONFIG" npx tsx scripts/ensure-cluster-stack.ts || die "the system cluster's monitoring and telemetry could not be applied; see above"

  local otel_ip
  otel_ip="$(collector_address)" || exit 1
  [ -n "$otel_ip" ] && [ "$otel_ip" != None ] || die "the cluster's collector has no cluster address"
  ok "the cluster's collector runs at ${otel_ip}"

  local mongo postgres root_password
  mongo="$(container mongodb)"; [ -n "$mongo" ] || die "Mongo's container is not running"
  postgres="$(container postgresql)"; [ -n "$postgres" ] || die "Temporal's Postgres container is not running"
  root_password="$(setting MONGO_ROOT_PASSWORD "$COMPOSE_ENV")"
  [ -n "$root_password" ] || die "${COMPOSE_ENV} has no MONGO_ROOT_PASSWORD"
  mongo_monitor "$mongo" "$root_password" "$(kept_secret MONGO_EXPORTER_PASSWORD "$COMPOSE_ENV")"
  ok "Mongo is read by ${MONGO_USER}, which may only watch it (clusterMonitor, and read on local)"
  postgres_monitor "$postgres" "$(kept_secret POSTGRES_EXPORTER_PASSWORD "$COMPOSE_ENV")"
  ok "Temporal's Postgres is read by ${POSTGRES_ROLE}, which may only watch it (pg_monitor)"
  docker compose --env-file "$COMPOSE_ENV" -f docker-compose.exporters.yml up -d >/dev/null \
    || die "the exporters did not start. Check: docker compose -f docker-compose.exporters.yml logs"

  install -d -m 755 "$METRICS_DIR"
  put OTEL_CLUSTER_COLLECTOR "${otel_ip}:4317" "$COMPOSE_ENV"
  docker compose --env-file "$COMPOSE_ENV" -f docker-compose.otel.yml up -d --force-recreate >/dev/null \
    || die "the host collector did not start. Check: docker logs nowrinkles-otel"
  put OTEL_EXPORTER_OTLP_ENDPOINT "http://127.0.0.1:4318" "$BACKEND_ENV"
  loopback_only
  ok "Koala's processes, Caddy, Mongo, Postgres, Temporal, Headscale, the registry, mail and backups report through 127.0.0.1:4318 to the collector at ${otel_ip}, every metrics port on loopback only"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
