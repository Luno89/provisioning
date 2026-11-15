#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="${ROOT}/bin/docker-compose"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/koala"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/koala"

if [ "$(id -u)" -eq 0 ]; then
  echo "Run npm run dev:reset as yourself, not with sudo."
  exit 1
fi

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "Stopping dev's root, hub and web servers"
for port in 3002 3003 5173 5175 5176; do
  for pid in $(lsof -ti ":${port}" 2>/dev/null || true); do
    if [ "$(ps -o uid= -p "$pid" | tr -d ' ')" = "$(id -u)" ]; then kill "$pid"; fi
  done
done

say "Removing this computer as a machine: its k3s with the Koala on it, its token, its service"
(cd "${ROOT}" && npx tsx apps/local-agent/src/index.ts remove)
rm -rf "${DATA_HOME}/machine" "${DATA_HOME}/cluster-wanted" "${DATA_HOME}/koala-here" "${CONFIG_HOME}/koala-values.yaml"

say "Dropping root's and the hub's dev databases (koala_dev_root, koala_dev_hub)"
"${COMPOSE}" -f "${ROOT}/docker-compose.mongo.yml" exec -T mongodb \
  mongosh --quiet -u admin -p admin --authenticationDatabase admin \
  --eval 'for (const name of ["koala_dev_root", "koala_dev_hub"]) db.getSiblingDB(name).dropDatabase()'

say "Emptying root's Temporal and Headscale"
"${COMPOSE}" -f "${ROOT}/docker-compose.temporal.yml" down -v
"${COMPOSE}" -f "${ROOT}/docker-compose.headscale.yml" down -v

say "Forgetting what dev wrote for root and the hub"
rm -rf "${ROOT}/apps/backend/data/dev"

echo ""
echo "Dev is reset. npm run dev starts it fresh: root, a new owner, this computer joined as their machine, Koala on it."
