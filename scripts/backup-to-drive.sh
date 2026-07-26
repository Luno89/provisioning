#!/usr/bin/env bash
# backup-to-drive.sh — Backs up the things that aren't reproducible to Google Drive via rclone:
#   1. MongoDB (all cluster/deployment/user state — the only source of truth for it)
#   2. .k3d-storage/ (deployed apps' persistent data — Odoo DB dumps, Nextcloud files, etc.)
#   3. apps/backend/.env (JWT signing key, OAuth/Twilio/Terraform Cloud secrets) — encrypted via
#      a separate rclone "crypt" remote, since this file alone can unlock everything else.
#
# Deliberately NOT backed up:
#   - Docker images: pullable from Docker Hub/ghcr.io, or rebuildable from Dockerfiles in git.
#   - .vllm-model-cache/ and .tabbyapi-model-cache/: free to re-download from Hugging Face:
#     syncing 10s of GB of model weights to Drive on every run buys nothing.
#
# Setup — either one works:
#   A) In the app: Account → Backup Destinations → Connect with Google (recommended, no CLI)
#   B) Manually:   bin/rclone config
#                    -> new remote named "gdrive"        type: drive   (OAuth via browser)
#                    -> new remote named "gdrive-crypt"  type: crypt   remote: gdrive:ProvisioningBackups/secrets-encrypted
#                                                         filename_encryption: standard, set a password
#
# Usage: scripts/backup-to-drive.sh   (also wired to `npm run backup`)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RCLONE="$ROOT/bin/rclone"
[ -f "$RCLONE" ] || RCLONE="rclone"

REMOTE_MONGO="gdrive:ProvisioningBackups/mongo"
REMOTE_STORAGE="gdrive:ProvisioningBackups/k3d-storage"
REMOTE_SECRETS="gdrive-crypt:"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
TMP_DIR="$ROOT/.backup-tmp"

if ! "$RCLONE" version >/dev/null 2>&1; then
  echo "❌ rclone not found. Run: npm run setup (downloads it into bin/rclone)"
  exit 1
fi

# Prefer the credentials connected in-app; fall back to a manually-run `rclone config` (its
# default config location, untouched by RCLONE_CONFIG below) for anyone who set it up that way.
# Deleted first so a stale file from a since-disconnected account can't be mistaken for a fresh
# one below — the generator (re)writes it fresh on success, or not at all on failure.
GENERATED_CONF_PATH="$ROOT/.rclone-runtime.conf"
rm -f "$GENERATED_CONF_PATH"
(cd "$ROOT" && npx tsx apps/backend/src/scripts/generate-rclone-config.ts >/dev/null 2>&1 || true)
if [ -f "$GENERATED_CONF_PATH" ]; then
  export RCLONE_CONFIG="$GENERATED_CONF_PATH"
  echo "▶ Using Google Drive account connected via the app (Account → Backup Destinations)"
elif "$RCLONE" listremotes 2>/dev/null | grep -q '^gdrive:'; then
  echo "▶ Using manually-configured rclone remotes ($($RCLONE config file 2>/dev/null | tail -1))"
else
  echo "❌ No Google Drive connection found. Connect it in the app (Account → Backup Destinations) or run: bin/rclone config"
  exit 1
fi
HAVE_CRYPT="$("$RCLONE" listremotes 2>/dev/null | grep -c '^gdrive-crypt:' || true)"

mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

# Same docker-compose resolution as cleanup-all.sh, for consistency.
DOCKER_COMPOSE="docker-compose"
if ! command -v docker-compose >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif [ -f "$ROOT/bin/docker-compose" ]; then
    DOCKER_COMPOSE="$ROOT/bin/docker-compose"
  fi
fi

# ── 1. MongoDB dump ──
echo "▶ Dumping MongoDB..."
MONGO_DUMP="$TMP_DIR/mongo-$TIMESTAMP.gz"
# Credentials match docker-compose.mongo.yml's MONGO_INITDB_ROOT_USERNAME/PASSWORD (dev-default
# admin/admin — this compose file is local-only and never exposed beyond localhost:27017).
if ! $DOCKER_COMPOSE -f "$ROOT/docker-compose.mongo.yml" exec -T mongodb \
    mongodump --archive --gzip -u admin -p admin --authenticationDatabase admin > "$MONGO_DUMP"; then
  echo "❌ mongodump failed — is the mongodb container running? (npm run dev / docker compose -f docker-compose.mongo.yml up -d)"
  exit 1
fi

# ── 2. .k3d-storage (deployed apps' persistent data) ──
K3D_STORAGE_ARCHIVE=""
if [ -d "$ROOT/.k3d-storage" ] && [ -n "$(ls -A "$ROOT/.k3d-storage" 2>/dev/null)" ]; then
  echo "▶ Archiving .k3d-storage..."
  K3D_STORAGE_ARCHIVE="$TMP_DIR/k3d-storage-$TIMESTAMP.tar.gz"
  tar czf "$K3D_STORAGE_ARCHIVE" -C "$ROOT" .k3d-storage
else
  echo "  (skipping .k3d-storage — empty, nothing deployed with persistent data yet)"
fi

# ── 3. Upload ──
echo "▶ Uploading to Google Drive..."
"$RCLONE" copy "$MONGO_DUMP" "$REMOTE_MONGO/" --progress
if [ -n "$K3D_STORAGE_ARCHIVE" ]; then
  "$RCLONE" copy "$K3D_STORAGE_ARCHIVE" "$REMOTE_STORAGE/" --progress
fi
if [ "$HAVE_CRYPT" -eq 0 ]; then
  echo "  (skipping .env — no backup encryption password set yet: Account → Backup Destinations → Backup Encryption Password)"
elif [ -f "$ROOT/apps/backend/.env" ]; then
  echo "▶ Uploading encrypted secrets..."
  "$RCLONE" copy "$ROOT/apps/backend/.env" "$REMOTE_SECRETS" --progress
else
  echo "  (skipping .env — not found at apps/backend/.env)"
fi

# ── 4. Prune backups older than retention window ──
echo "▶ Pruning backups older than ${RETENTION_DAYS}d..."
"$RCLONE" delete "$REMOTE_MONGO" --min-age "${RETENTION_DAYS}d" || true
"$RCLONE" delete "$REMOTE_STORAGE" --min-age "${RETENTION_DAYS}d" || true

echo "✅ Backup complete: $(date)"
