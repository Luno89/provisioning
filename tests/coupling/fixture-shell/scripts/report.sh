#!/bin/sh
set -eu
say() {
  printf '%s\n' "$1"
}
post() {
  out=$(curl -sS \
    -d "$1" "$ROOT_URL/api/things")
  printf '%s\n' "$out"
}
never() {
  curl -sS "$ROOT_URL/api/never"
}
say start
post hello
bash "$(dirname "$0")/child.sh"
