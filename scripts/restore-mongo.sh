#!/usr/bin/env bash
# restore-mongo.sh — Local MongoDB restore script with user confirmation
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${ROOT}/backups"
DEFAULT_ARCHIVE="${BACKUP_DIR}/mongo_backup_latest.archive.gz"

ARCHIVE_PATH="${1:-$DEFAULT_ARCHIVE}"
AUTO_YES=0

for arg in "$@"; do
  if [ "$arg" = "-y" ] || [ "$arg" = "--yes" ]; then
    AUTO_YES=1
  elif [ -f "$arg" ]; then
    ARCHIVE_PATH="$arg"
  fi
done

if [ ! -f "$ARCHIVE_PATH" ]; then
  echo "❌ Backup archive not found: ${ARCHIVE_PATH}"
  exit 1
fi

echo "📦 Found MongoDB backup archive:"
echo "   File: ${ARCHIVE_PATH} ($(du -h "$ARCHIVE_PATH" | cut -f1))"

if [ "$AUTO_YES" -eq 0 ]; then
  read -r -p "⚠️  Do you want to restore MongoDB from this backup? This will overwrite current data. (y/N): " CONFIRM
  case "$CONFIRM" in
    [yY][eE][sS]|[yY])
      echo "▶ Proceeding with restore..."
      ;;
    *)
      echo "❌ Restore cancelled by user."
      exit 0
      ;;
  esac
fi

# Ensure container is running
if ! docker ps --format '{{.Names}}' | grep -q '^provisioning-mongodb-1$'; then
  echo "▶ Starting MongoDB container..."
  bash "${ROOT}/scripts/ensure-mongo.sh"
fi

echo "▶ Copying archive to MongoDB container..."
docker cp "$ARCHIVE_PATH" "provisioning-mongodb-1:/tmp/restore_mongo.archive.gz"

echo "▶ Restoring MongoDB database 'provisioning' (with --drop)..."
if docker exec provisioning-mongodb-1 mongorestore \
  -u admin -p admin --authenticationDatabase admin \
  --drop \
  --archive="/tmp/restore_mongo.archive.gz" \
  --gzip; then
  docker exec provisioning-mongodb-1 rm -f "/tmp/restore_mongo.archive.gz"
  echo "✅ MongoDB restored successfully from ${ARCHIVE_PATH}"
else
  docker exec provisioning-mongodb-1 rm -f "/tmp/restore_mongo.archive.gz"
  echo "❌ MongoDB restore failed."
  exit 1
fi
