#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
ok()  { echo -e "  ${GREEN}✅${NC} $1"; }
die() { echo -e "  ${RED}❌${NC} $1"; exit 1; }

RECORD="${KOALA_ETC:-/etc/koala}/ssh-over-mesh"
[ "$(id -u)" -eq 0 ] || die "Run as root: this changes the firewall."

if [ "${1:-}" = "--public" ]; then
  ufw allow OpenSSH >/dev/null
  rm -f "$RECORD"
  ok "SSH answers from the internet again"
  exit 0
fi

MESH_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
[ -n "$MESH_IP" ] || die "this host is not on its mesh, so closing SSH to the internet would leave only the provider's console"
ss -tnH state established "( sport = :22 )" | awk '{print $3}' | grep -q "^${MESH_IP}:22$" \
  || die "no SSH session arrives over the mesh (at ${MESH_IP}). Put your computer on the mesh with admin-machine.sh, sign in at ${MESH_IP}, and run this from that session"
ufw allow in on tailscale0 to any port 22 proto tcp >/dev/null
ufw delete allow OpenSSH >/dev/null 2>&1 || true
install -d -m 755 "$(dirname "$RECORD")"
date -u +%FT%TZ > "$RECORD"
ok "SSH answers only over the mesh, at ${MESH_IP}; if the mesh is down, the provider's console is the way in (ssh-over-mesh.sh --public opens it again)"
