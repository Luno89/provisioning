#!/bin/sh
set -eu

report() {
  curl -fsS -X POST -H "Content-Type: application/json" \
    -d "$1" "${ROOT_URL}/api/items/${ITEM_ID}/discard"
}

# curl "${ROOT_URL}/api/not-a-call"
curl -fsSL "${ROOT_URL}/install.sh" -o /tmp/install.sh
report '{"done":true}'
