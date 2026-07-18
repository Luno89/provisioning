#!/usr/bin/env bash
# ensure-temporal.sh — If the Temporal server is not already running, start it automatically.
#
# This script is called from `npm run dev` to ensure Temporal is available before
# starting the dev servers and workers.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TEMPORAL_PORT=7233
COMPOSE_FILE="${ROOT}/docker-compose.temporal.yml"

# Resolve docker-compose binary (same pattern as first-time.sh)
DOCKER_COMPOSE="${ROOT}/bin/docker-compose"
if [ ! -f "$DOCKER_COMPOSE" ] || ! "$DOCKER_COMPOSE" version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  elif docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  else
    echo "❌ Error: docker-compose not found. Cannot start Temporal."
    exit 1
  fi
fi

check_temporal() {
  if true &>/dev/null </dev/tcp/127.0.0.1/${TEMPORAL_PORT}; then
    return 0
  fi
  return 1
}

if check_temporal; then
  echo "  ▶  Temporal server already running on port ${TEMPORAL_PORT} — skipping startup"
else
  echo "  ▶  Starting Temporal server..."
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d

  echo "  ▶  Waiting for Temporal to be healthy on port ${TEMPORAL_PORT}..."
  MAX_RETRIES=30
  RETRY=0
  until check_temporal || [ $RETRY -ge $MAX_RETRIES ]; do
    sleep 2
    RETRY=$((RETRY + 1))
  done

  if check_temporal; then
    echo "  ▶  Temporal server is ready"
  else
    echo "  ❌  Temporal server failed to start within $((MAX_RETRIES * 2))s"
    exit 1
  fi
fi
