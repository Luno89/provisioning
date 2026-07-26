#!/usr/bin/env bash
# ensure-headscale.sh — If Headscale is not already running, start it automatically.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

HEADSCALE_PORT=8080
COMPOSE_FILE="${ROOT}/docker-compose.headscale.yml"

DOCKER_COMPOSE="${ROOT}/bin/docker-compose"
if [ ! -f "$DOCKER_COMPOSE" ] || ! "$DOCKER_COMPOSE" version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  elif docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  else
    echo "❌ Error: docker-compose not found. Cannot start Headscale."
    exit 1
  fi
fi

check_headscale() {
  if true &>/dev/null </dev/tcp/127.0.0.1/${HEADSCALE_PORT}; then
    return 0
  fi
  return 1
}

if check_headscale; then
  echo "  ▶  Headscale already running on port ${HEADSCALE_PORT} — skipping startup"
else
  echo "  ▶  Starting Headscale..."
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d

  echo "  ▶  Waiting for Headscale to be healthy on port ${HEADSCALE_PORT}..."
  MAX_RETRIES=30
  RETRY=0
  until check_headscale || [ $RETRY -ge $MAX_RETRIES ]; do
    sleep 2
    RETRY=$((RETRY + 1))
  done

  if check_headscale; then
    echo "  ▶  Headscale is ready"
  else
    echo "  ❌  Headscale failed to start within $((MAX_RETRIES * 2))s"
    exit 1
  fi
fi
