#!/bin/sh
set -eu

K3S_VERSION="v1.36.4+k3s1"
K3S_INSTALLER_SHA256=46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad
TAILSCALE_VERSION=1.104.1
TAILSCALE_SHA256_AMD64=108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528
TAILSCALE_SHA256_ARM64=f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806

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

arch_of() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "this machine is $(uname -m); Koala installs on amd64 and arm64" ;;
  esac
}

fetch_checked() {
  curl -fsSL "$1" -o "$3" || die "could not download $1"
  printf '%s  %s\n' "$2" "$3" | sha256sum -c --quiet - >/dev/null 2>&1 || { rm -f "$3"; die "the download from $1 is not the one Koala pins (its sha256 differs); nothing was installed"; }
}

install_k3s() {
  installer="$(mktemp)"
  fetch_checked "https://raw.githubusercontent.com/k3s-io/k3s/$(printf '%s' "$K3S_VERSION" | sed 's/+/%2B/')/install.sh" "$K3S_INSTALLER_SHA256" "$installer"
  INSTALL_K3S_VERSION="$K3S_VERSION" sh "$installer" >/dev/null
  rm -f "$installer"
}

install_tailscale() {
  arch="$(arch_of)"
  if [ "$arch" = amd64 ]; then sha="$TAILSCALE_SHA256_AMD64"; else sha="$TAILSCALE_SHA256_ARM64"; fi
  work="$(mktemp -d)"
  fetch_checked "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${arch}.tgz" "$sha" "$work/tailscale.tgz"
  tar -xzf "$work/tailscale.tgz" -C "$work"
  from="$work/tailscale_${TAILSCALE_VERSION}_${arch}"
  install -m 755 "$from/tailscale" /usr/bin/tailscale
  install -m 755 "$from/tailscaled" /usr/sbin/tailscaled
  install -m 644 "$from/systemd/tailscaled.service" /etc/systemd/system/tailscaled.service
  [ -f /etc/default/tailscaled ] || install -m 644 "$from/systemd/tailscaled.defaults" /etc/default/tailscaled
  rm -rf "$work"
  systemctl daemon-reload
  systemctl enable --now tailscaled >/dev/null 2>&1
}

[ "$(id -u)" = 0 ] || die "run this as root"
[ -s "$ACCOUNT" ] || die "copy k8s/root-backend/account.yaml from the checkout to $ACCOUNT first: it is the narrow account root's backend reaches this node with"
[ -n "$LOGIN_SERVER" ] && [ -n "$AUTHKEY" ] && [ -n "$REGISTRY" ] || die "usage: pool-node.sh --login-server <headscale url> --authkey <tag:pool key> --registry <root registry host:port> [--gvisor-tarball <file>] [--yes]"

say "k3s"
if command -v k3s >/dev/null 2>&1; then
  ok "k3s is installed"
else
  install_k3s
  ok "k3s $K3S_VERSION installed"
fi

say "The mesh"
command -v tailscale >/dev/null 2>&1 || { install_tailscale; ok "Tailscale $TAILSCALE_VERSION installed"; }
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

say "k3s answers on its node ports only on this machine and the mesh"
NODE_PORTS=/etc/rancher/k3s/config.yaml.d/koala-node-ports.yaml
WANTED_NODE_PORTS="$(printf 'kube-proxy-arg+:\n  - nodeport-addresses=127.0.0.1/32,100.64.0.0/10')"
if [ -f "$NODE_PORTS" ] && [ "$(cat "$NODE_PORTS")" = "$WANTED_NODE_PORTS" ]; then
  ok "node ports stay off this server's public address"
else
  mkdir -p "$(dirname "$NODE_PORTS")"
  printf '%s\n' "$WANTED_NODE_PORTS" > "$NODE_PORTS"
  CHANGED=1
  ok "node ports will stay off this server's public address (kube-proxy's rules run before any firewall's)"
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
