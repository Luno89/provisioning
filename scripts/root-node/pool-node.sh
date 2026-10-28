#!/bin/sh
set -eu

LOGIN_SERVER=""
AUTHKEY=""
REGISTRY=""
TARBALL=""
YES=0
HERE="$(cd "$(dirname "$0")" && pwd)"
KUBECONFIG_OUT=/root/pool-kubeconfig.yaml
BACKEND_OUT=/root/pool-backend-kubeconfig.yaml
ACCOUNT="$HERE/koala-backend-account.yaml"

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
[ -s "$ACCOUNT" ] || die "copy k8s/root-backend/account.yaml from the checkout to $ACCOUNT first: it is the narrow account root's backend reaches this node with"
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
  ENTRY_FILE="$(mktemp)"
  printf '  "%s":\n    endpoint:\n      - "http://%s"\n' "$REGISTRY" "$REGISTRY" > "$ENTRY_FILE"
  if [ -f "$REGISTRIES" ] && grep -q '^mirrors:' "$REGISTRIES"; then
    sed -i "/^mirrors:/r ${ENTRY_FILE}" "$REGISTRIES"
  else
    { echo 'mirrors:'; cat "$ENTRY_FILE"; } >> "$REGISTRIES"
  fi
  rm -f "$ENTRY_FILE"
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

say "Root's backend's own account"
k3s kubectl apply -f "$ACCOUNT" >/dev/null
TOKEN=""
for _ in $(seq 1 60); do
  TOKEN="$(k3s kubectl -n kube-system get secret koala-backend-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  [ -n "$TOKEN" ] && break
  sleep 1
done
[ -n "$TOKEN" ] || die "the node gave the koala-backend account no token"
CA="$(k3s kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
( umask 077; cat > "$BACKEND_OUT" <<CONF
apiVersion: v1
kind: Config
clusters:
  - name: pool
    cluster:
      server: https://$MESH_IP:6443
      certificate-authority-data: $CA
users:
  - name: koala-backend
    user:
      token: $TOKEN
contexts:
  - name: koala-backend
    context:
      cluster: pool
      user: koala-backend
current-context: koala-backend
CONF
)
ok "koala-backend may read the pool's Prometheus and, in each trial's namespace, what the workers bind it to"

say "For root"
sed "s|server: https://127.0.0.1:6443|server: https://$MESH_IP:6443|" /etc/rancher/k3s/k3s.yaml > "$KUBECONFIG_OUT"
chmod 600 "$KUBECONFIG_OUT"
ok "copy $KUBECONFIG_OUT to root as POOL_KUBECONFIG (the workers' only), $BACKEND_OUT to root's /etc/koala/pool-backend-kubeconfig (the backend's), and set POOL_ADDRESS=$MESH_IP"
