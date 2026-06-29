#!/bin/bash
# Temporal Worker Entrypoint
# This is the long-running component that executes workflow tasks.
# Run via:  npm run dev:worker
# Or via Docker: docker run --name temporal-worker --add-host=host.docker.internal:host-gateway -v backend-src:/app src-image
echo "🚀 Starting Temporal Workflow Worker..."

cd /home/luno/Code/provisioning/apps/backend

# Temporal configuration
export TEMPORAL_TEMPLATING_STANDALONE=true
export JWT_SECRET=dev-jwt-secret-do-not-use-in-production

# Worker connection settings
export WORKER_URL="${TEMPORAL_WORKER_URL:-http://localhost:7233}"

# Temporal logger level
export TEMPORAL_LOG_LEVEL="info"

npx tsx src/worker.ts
