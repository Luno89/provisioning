#!/usr/bin/env bash
# backup-mongo.sh — Local MongoDB backup script
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${ROOT}/backups"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
ARCHIVE_NAME="mongo_backup_${TIMESTAMP}.archive.gz"
LATEST_LINK="mongo_backup_latest.archive.gz"

mkdir -p "$BACKUP_DIR"

echo "▶ Dumping MongoDB database 'provisioning'..."
if ! docker exec provisioning-mongodb-1 mongodump \
  -u admin -p admin --authenticationDatabase admin \
  --db provisioning \
  --archive="/tmp/${ARCHIVE_NAME}" \
  --gzip; then
  echo "❌ MongoDB dump failed."
  exit 1
fi

docker cp "provisioning-mongodb-1:/tmp/${ARCHIVE_NAME}" "${BACKUP_DIR}/${ARCHIVE_NAME}"
docker exec provisioning-mongodb-1 rm -f "/tmp/${ARCHIVE_NAME}"

cp -f "${BACKUP_DIR}/${ARCHIVE_NAME}" "${BACKUP_DIR}/${LATEST_LINK}"

echo "✅ Backup created successfully: ${BACKUP_DIR}/${ARCHIVE_NAME}"
echo "   Latest link updated: ${BACKUP_DIR}/${LATEST_LINK}"
