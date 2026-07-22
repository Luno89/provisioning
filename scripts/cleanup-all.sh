#!/usr/bin/env bash
# cleanup-all — Safely terminates all stale Node/Playwright processes, purges all k3d clusters, resets DBs, and cleans locks.
set -euo pipefail

ROOT="$(cd "$(dirname -- "$0")/.." && pwd)"

echo "🧹 Starting full repository and container cleanup..."

# 1. Kill stale Node, Playwright, tsx, cdktf, and vite processes
echo "  ▶  Killing active Node/tsx/Vite/Playwright processes..."
PIDS=$(ps auxww | grep -E 'vite|tsx|cdktf|concurrently|worker|playwright' | grep "$ROOT" | grep -v grep | awk '{print $2}' || true)
if [ -n "$PIDS" ]; then
  kill -9 $PIDS 2>/dev/null || true
fi

# 2. Find and delete all k3d clusters (both dev and E2E)
K3D="$ROOT/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

if command -v "$K3D" >/dev/null 2>&1 || "$K3D" --version >/dev/null 2>&1; then
  echo "  ▶  Deleting all k3d clusters..."
  CLUSTERS=$("$K3D" cluster list --no-headers 2>/dev/null | awk '{print $1}' || true)
  for c in $CLUSTERS; do
    echo "    ✖  Deleting cluster: $c"
    "$K3D" cluster delete "$c" >/dev/null 2>&1 || true
  done
fi

# Note: Host Docker images (e.g. vllm/vllm-openai, odoo, postgres) are intentionally preserved in host image cache to prevent re-downloading.
# Purge any remaining orphaned containers/volumes that K3d fails to list
echo "  ▶  Purging all leftover k3d Docker containers and volumes..."
STALE_CONTS=$(docker ps -a --filter "name=k3d-" -q)
if [ -n "$STALE_CONTS" ]; then
  docker rm -f $STALE_CONTS >/dev/null 2>&1 || true
fi
STALE_VOLS=$(docker volume ls --filter "name=k3d-" -q)
if [ -n "$STALE_VOLS" ]; then
  docker volume rm $STALE_VOLS >/dev/null 2>&1 || true
fi

# 2b. Reset the native k3s management cluster's state (Linux only — on macOS the management
#     cluster is k3d, already covered by the deletion loop above).
#
# clean only removes — it does not reinstall, reconfigure, or restart anything. That's setup's
# job (sudo bash scripts/setup-gpu.sh, then npm run setup) — see cluster.sh's native_k3s_reset
# for what this actually does (stop + wipe data-dir, nothing else).
if [ "$(uname -s)" = "Linux" ]; then
  "$ROOT/scripts/cluster.sh" reset provisioning-lunorica
fi

# 3. Clean up lock files and state directories
echo "  ▶  Removing temporary state files..."
rm -rf "$ROOT/.test-e2e-state" "$ROOT/.test-server-state" "$ROOT/.k3d-cluster-state" 2>/dev/null || true

# 4. Reset MongoDB test database
echo "  ▶  Resetting MongoDB test database..."
DOCKER_COMPOSE="docker-compose"
if ! command -v docker-compose >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif [ -f "$ROOT/bin/docker-compose" ]; then
    DOCKER_COMPOSE="$ROOT/bin/docker-compose"
  fi
fi
$DOCKER_COMPOSE -f "$ROOT/docker-compose.mongo.yml" down -v >/dev/null 2>&1 || true

# 4b. Clean up log files
echo "  ▶  Cleaning up workspace and backend logs..."
rm -rf "$ROOT/apps/backend/data/logs"/* 2>/dev/null || true
rm -f "$ROOT"/*.log 2>/dev/null || true

# 5. Clean up any leftover nginx files or containers if applicable
if docker inspect provisioner-nginx >/dev/null 2>&1; then
  echo "  ▶  Resetting provisioner-nginx container..."
  NGINX_CONF="$ROOT/apps/backend/data/nginx/nginx.conf"
  if [ -f "$NGINX_CONF" ]; then
    cat << 'EOF' > "$NGINX_CONF"
user  nginx;
worker_processes  auto;

error_log  /var/log/nginx/error.log notice;
pid        /var/run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    keepalive_timeout  65;
    client_max_body_size 10G;

    include /etc/nginx/conf.d/*.conf;
}
EOF
    docker exec provisioner-nginx nginx -s reload >/dev/null 2>&1 || true
  fi
fi

# 6. Reset local Temporal server to clear stale workflows
echo "  ▶  Resetting local Temporal server..."
DOCKER_COMPOSE="docker-compose"
if ! command -v docker-compose >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif [ -f "$ROOT/bin/docker-compose" ]; then
    DOCKER_COMPOSE="$ROOT/bin/docker-compose"
  fi
fi
$DOCKER_COMPOSE -f "$ROOT/docker-compose.temporal.yml" down -v >/dev/null 2>&1 || true
$DOCKER_COMPOSE -f "$ROOT/docker-compose.temporal.yml" up -d >/dev/null 2>&1 || true
echo "  ▶  Waiting for Temporal server to become healthy..."
for i in {1..30}; do
  CONTAINER_STATUS=$(docker ps --filter "name=temporal" --filter "health=healthy" -q)
  if [ -n "$CONTAINER_STATUS" ]; then
    echo "  ✅ Temporal server is healthy!"
    break
  fi
  sleep 2
done

echo "✅ Cleanup complete!"
if [ "$(uname -s)" = "Linux" ] && [ -f "/etc/systemd/system/k3s-provisioning-lunorica.service" ]; then
  echo ""
  echo "ℹ️  The native k3s management cluster was reset (stopped + state wiped) and is not"
  echo "   running. Bring it back up with:"
  echo "     sudo bash scripts/setup-gpu.sh   # only if you have a GPU"
  echo "     npm run setup"
fi
