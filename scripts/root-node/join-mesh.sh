#!/usr/bin/env bash
set -euo pipefail

[ $# -eq 2 ] && [ -n "${MESH_AUTHKEY:-}" ] || { echo "MESH_AUTHKEY=<key> join-mesh.sh <login server> <hostname>" >&2; exit 2; }
SERVER="$1"
NAME="$2"
OUT="$(mktemp)"
SINCE="$(date '+%Y-%m-%d %H:%M:%S')"
UP=""
SEEN=""

finish() {
  [ -z "$UP" ] || kill "$UP" 2>/dev/null || true
  rm -f "$OUT"
}
trap finish EXIT

tailscale up --login-server="$SERVER" --authkey="$MESH_AUTHKEY" --hostname="$NAME" >"$OUT" 2>&1 &
UP=$!

until tailscale ip -4 >/dev/null 2>&1; do
  if [ -n "$UP" ] && ! kill -0 "$UP" 2>/dev/null; then
    if wait "$UP"; then UP=""; continue; fi
    UP=""
    echo "tailscale up failed: $(tail -n1 "$OUT")" >&2
    exit 1
  fi
  while IFS= read -r said; do
    error="${said#*Received error: }"
    case "$error" in
      *x509:*|*tls:*|*certificate*)
        echo "Tailscale cannot join ${SERVER}: ${error}" >&2
        exit 1 ;;
    esac
    case "$SEEN" in
      *"|${error}|"*) ;;
      *) SEEN="${SEEN}|${error}|"; echo "Tailscale is still trying ${SERVER}: ${error}" >&2 ;;
    esac
  done < <(journalctl -u tailscaled --since "$SINCE" -o cat --no-pager 2>/dev/null | grep 'Received error: ' || true)
  sleep 2
done

[ -z "$UP" ] || { wait "$UP" || true; UP=""; }
tailscale ip -4 | head -n1
