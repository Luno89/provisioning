#!/bin/sh
set -eu

LOGIN_SERVER=""
AUTHKEY=""
REGISTRY=""
TARBALL=""
YES=0
HERE="$(cd "$(dirname "$0")" && pwd)"
KUBECONFIG_OUT=/root/pool-kubeconfig.yaml

while [ $# -gt 0 ]; do
  case "$1" in
    --login-server) LOGIN_SERVER="$2"; shift ;;
    --authkey) AUTHKEY="$2"; shift ;;
    --registry) REGISTRY="$2"; shift ;;
    --gvisor-tarball) TARBALL="$2"; shift ;;
    --yes) YES=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root"
[ -n "$LOGIN_SERVER" ] && [ -n "$AUTHKEY" ] && [ -n "$REGISTRY" ] || die "usage: pool-node.sh --login-server <headscale url> --authkey <tag:pool key> --registry <root registry host:port> [--gvisor-tarball <file>] [--yes]"

say "k3s"
if command -v k3s >/dev/null 2>&1; then
  ok "k3s is installed"
else
  curl -sfL https://get.k3s.io | sh - >/dev/null
  ok "k3s installed"
fi

say "The mesh"
command -v tailscale >/dev/null 2>&1 || { curl -fsSL https://tailscale.com/install.sh | sh >/dev/null; ok "Tailscale installed"; }
if ! tailscale ip -4 >/dev/null 2>&1; then
  tailscale up --login-server="$LOGIN_SERVER" --authkey="$AUTHKEY" --hostname="pool-$(hostname)" --accept-dns=false
fi
MESH_IP="$(tailscale ip -4 | head -1)"
[ -n "$MESH_IP" ] || die "the node did not get a mesh address"
ok "on the mesh as $MESH_IP"

CHANGED=0
say "k3s answers on the mesh address"
CONFIG=/etc/rancher/k3s/config.yaml
if [ -f "$CONFIG" ] && grep -q "$MESH_IP" "$CONFIG"; then
  ok "its certificate names $MESH_IP"
else
  [ -f "$CONFIG" ] && grep -q '^tls-san:' "$CONFIG" && die "$CONFIG has tls-san of its own; add $MESH_IP to it by hand"
  printf 'tls-san:\n  - "%s"\n' "$MESH_IP" >> "$CONFIG"
  CHANGED=1
  ok "its certificate will name $MESH_IP"
fi

say "Root's registry"
REGISTRIES=/etc/rancher/k3s/registries.yaml
if [ -f "$REGISTRIES" ] && grep -q "\"$REGISTRY\"" "$REGISTRIES"; then
  ok "k3s pulls from $REGISTRY"
else
  [ -f "$REGISTRIES" ] && grep -q '^mirrors:' "$REGISTRIES" && die "$REGISTRIES has mirrors of its own; add $REGISTRY to it by hand"
  printf 'mirrors:\n  "%s":\n    endpoint:\n      - "http://%s"\n' "$REGISTRY" "$REGISTRY" >> "$REGISTRIES"
  CHANGED=1
  ok "k3s pulls from $REGISTRY"
fi

if [ "$CHANGED" = 1 ] && grep -q "runtimes.runsc" /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl 2>/dev/null; then
  systemctl restart k3s
fi
set --
[ -n "$TARBALL" ] && set -- "$@" --tarball "$TARBALL"
[ "$YES" = 1 ] && set -- "$@" --yes
sh "$HERE/gvisor.sh" "$@"

say "For root"
sed "s|server: https://127.0.0.1:6443|server: https://$MESH_IP:6443|" /etc/rancher/k3s/k3s.yaml > "$KUBECONFIG_OUT"
chmod 600 "$KUBECONFIG_OUT"
ok "copy $KUBECONFIG_OUT to root as POOL_KUBECONFIG, and set POOL_ADDRESS=$MESH_IP"
