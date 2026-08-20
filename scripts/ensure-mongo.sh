#!/usr/bin/env bash
# ensure-mongo.sh — If MongoDB is not already running, start it automatically.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MONGO_PORT=27017
COMPOSE_FILE="${ROOT}/docker-compose.mongo.yml"

# Resolve docker-compose binary
DOCKER_COMPOSE="${ROOT}/bin/docker-compose"
if [ ! -f "$DOCKER_COMPOSE" ] || ! "$DOCKER_COMPOSE" version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  elif docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  else
    echo "❌ Error: docker-compose not found. Cannot start MongoDB."
    exit 1
  fi
fi

check_mongo() {
  if true &>/dev/null </dev/tcp/127.0.0.1/${MONGO_PORT}; then
    return 0
  fi
  return 1
}

if check_mongo; then
  echo "  ▶  MongoDB already running on port ${MONGO_PORT} — skipping startup"
else
  echo "  ▶  Starting MongoDB..."
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d

  echo "  ▶  Waiting for MongoDB to be healthy on port ${MONGO_PORT}..."
  MAX_RETRIES=30
  RETRY=0
  until check_mongo || [ $RETRY -ge $MAX_RETRIES ]; do
    sleep 2
    RETRY=$((RETRY + 1))
  done

  if check_mongo; then
    echo "  ▶  MongoDB is ready"
  else
    echo "  ❌  MongoDB failed to start within $((MAX_RETRIES * 2))s"
    exit 1
  fi
fi

# Check if database is empty and a backup exists to offer restoring
LATEST_BACKUP="${ROOT}/backups/mongo_backup_latest.archive.gz"
if [ -f "$LATEST_BACKUP" ] && [ -t 0 ]; then
  # Check if users collection has any documents
  DOC_COUNT="$(docker exec provisioning-mongodb-1 mongosh -u admin -p admin --authenticationDatabase admin provisioning --quiet --eval "db.users.countDocuments()" 2>/dev/null || echo "0")"
  if [ "$DOC_COUNT" = "0" ]; then
    echo ""
    echo "📦 An existing MongoDB backup was found (${LATEST_BACKUP})."
    read -r -p "   The current database is empty. Would you like to restore the backup? (y/N): " RESTORE_CONFIRM
    case "$RESTORE_CONFIRM" in
      [yY][eE][sS]|[yY])
        bash "${ROOT}/scripts/restore-mongo.sh" -y "$LATEST_BACKUP"
        ;;
      *)
        echo "   Skipping backup restoration."
        ;;
    esac
  fi
fi