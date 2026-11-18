#!/usr/bin/env bash
set -euo pipefail

for port in "$@"; do
  for pid in $(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true); do
    if [ "$(ps -o uid= -p "$pid" | tr -d ' ')" = "$(id -u)" ]; then kill "$pid" 2>/dev/null || true; fi
  done
done
