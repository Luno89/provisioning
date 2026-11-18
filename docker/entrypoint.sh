#!/bin/sh
set -e

cd /app/apps/backend
if [ "${DEV_WATCH:-}" = true ]; then
  case "${1:-backend}" in
    backend) exec npx tsx watch --exclude data src/index.ts ;;
    worker-engine|worker-cluster|worker-host) exec npx tsx watch --exclude data --include 'src/workflows/**' "src/$1.ts" ;;
  esac
fi
case "${1:-backend}" in
  backend) exec node --import tsx src/index.ts ;;
  worker-engine) exec node --import tsx src/worker-engine.ts ;;
  worker-cluster) exec node --import tsx src/worker-cluster.ts ;;
  worker-host) exec node --import tsx src/worker-host.ts ;;
  seed) exec node --import tsx src/scripts/seed-all.ts ;;
  setup-waits) exec node --import tsx src/scripts/setup-waits.ts ;;
  platform-services) exec node --import tsx src/scripts/platform-services.ts ;;
  move-data) exec node --import tsx src/scripts/move-import.ts data ;;
  move-restore) exec node --import tsx src/scripts/move-import.ts restore ;;
  self-upgrade) exec node --import tsx src/scripts/self-upgrade.ts ;;
  install-koala) shift; exec node --import tsx src/scripts/install-koala.ts "$@" ;;
  temporal-keys) exec node --import tsx src/scripts/temporal-keys.ts "${2:-/keys/temporal-jwks.json}" ;;
  *) exec "$@" ;;
esac
