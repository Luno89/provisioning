#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/backend"
npx tsx src/scripts/temporal-keys.ts "$ROOT/apps/backend/data/temporal-keys/temporal-jwks.json"
