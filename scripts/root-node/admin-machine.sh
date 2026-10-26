#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-}"
[ -n "$NAME" ] || { echo "admin-machine.sh <a name for your computer>" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root: this mints a key on root's own Headscale." >&2; exit 1; }
MESH_DOMAIN="$(grep "^MESH_DOMAIN=" "${REPO_DIR:-/opt/nowrinkles}/.env" 2>/dev/null | cut -d= -f2- || true)"
ROOT_MESH_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
[ -n "$MESH_DOMAIN" ] && [ -n "$ROOT_MESH_IP" ] || { echo "root is not on its own mesh yet; run bootstrap.sh first" >&2; exit 1; }
ADMIN="$(cat /etc/koala/admin-user 2>/dev/null || echo "$SUDO_USER")"
ROOT_USER_ID="$(docker exec provisioning-headscale headscale users list -o json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const u=JSON.parse(s).find((x)=>x.name==="platform-root");if(!u)process.exit(1);console.log(u.id)})')"
KEY="$(docker exec provisioning-headscale headscale preauthkeys create --user "$ROOT_USER_ID" --tags tag:admin --expiration 1h -o json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).key))')"
echo "On ${NAME}, within the hour (the key works once):"
echo "  sudo tailscale up --login-server https://${MESH_DOMAIN} --hostname ${NAME} --authkey ${KEY}"
echo "Then sign in over the mesh, and only then close SSH to the internet:"
echo "  ssh ${ADMIN}@${ROOT_MESH_IP}"
echo "  sudo bash ${REPO_DIR:-/opt/nowrinkles}/scripts/root-node/ssh-over-mesh.sh"
