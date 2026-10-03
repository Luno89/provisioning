#!/bin/sh
set -eu

ROOT_URL="__ROOT_URL__"
TOKEN=""
YES=0
PUBLIC_URL_OVERRIDE=""
NAMESPACE="nowrinkles"
RELEASE="instance"
NODE_PORT=30320
KUBECONFIG=/etc/rancher/k3s/k3s.yaml
export KUBECONFIG

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --url) PUBLIC_URL_OVERRIDE="$2"; shift ;;
    --root) ROOT_URL="$2"; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) TOKEN="$1" ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
ask() {
  [ "$YES" = 1 ] && return 0
  printf '  %s [y/N] ' "$1"
  read -r answer < /dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

[ -n "$TOKEN" ] || die "usage: curl -fsSL ${ROOT_URL}/install.sh | sudo sh -s -- <join token>"
[ "$(id -u)" = 0 ] || die "run this as root: pipe it into 'sudo sh -s -- <token>'"
[ "$(uname -s)" = Linux ] || die "an instance runs on Linux"
have curl || die "curl is needed to install anything"

say "Joining ${ROOT_URL}"
JOIN_ENV="$(mktemp)"
trap 'rm -f "$JOIN_ENV"' EXIT
HTTP_CODE="$(curl -sS -o "$JOIN_ENV" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "{\"token\":\"${TOKEN}\",\"machine\":\"$(hostname)\"}" "${ROOT_URL}/api/instances/join?format=env")"
[ "$HTTP_CODE" = 200 ] || die "root refused the join (${HTTP_CODE}): $(cat "$JOIN_ENV")"
. "$JOIN_ENV"
ok "this machine will be instance ${INSTANCE_ID}"

report() {
  curl -fsS -X POST -H 'Content-Type: application/json' -H "X-Instance-Id: ${INSTANCE_ID}" -H "Authorization: Bearer ${INSTANCE_CREDENTIAL}" \
    -d "{\"status\":\"$1\",\"detail\":\"$2\"$( [ -n "${3:-}" ] && printf ',"url":"%s"' "$3" )}" "${ROOT_URL}/api/instances/status" >/dev/null 2>&1 || true
}
trap 'status=$?; rm -f "$JOIN_ENV"; [ $status -ne 0 ] && report failed "The install command stopped on this machine; run it again to retry"' EXIT

say "Checking this machine"
MEM_MB=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
DISK_GB=$(df -Pm / | awk 'NR == 2 { print int($4 / 1024) }')
ok "${MEM_MB} MB of memory, ${DISK_GB} GB of disk free"
if [ "$MEM_MB" -lt 6000 ] || [ "$DISK_GB" -lt 20 ]; then
  echo "  An instance uses about 4 GB of memory before it does any work, and around 20 GB of disk."
  ask "Carry on anyway?" || die "stopped; nothing was installed"
fi

HOST_DOCKER=false
if have docker; then
  ok "Docker is installed"
  HOST_DOCKER=true
elif ask "Docker isn't installed. It lets this instance create local test clusters. Install it?"; then
  curl -fsSL https://get.docker.com | sh
  HOST_DOCKER=true
  ok "Docker installed"
else
  ok "carrying on without Docker — local test clusters will not be available"
fi

if have k3s; then
  ok "k3s is installed"
else
  ask "k3s isn't installed. The instance runs in it. Install k3s?" || die "stopped; an instance needs k3s"
  curl -sfL https://get.k3s.io | sh -
  ok "k3s installed"
fi

if have helm; then
  ok "helm is installed"
else
  ask "helm isn't installed. It installs the instance. Install helm?" || die "stopped; an instance is installed with helm"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  ok "helm installed"
fi

if have tailscale; then
  ok "Tailscale is installed"
else
  ask "Tailscale isn't installed. It joins this machine to your private mesh. Install it?" || die "stopped; an instance is reached over the mesh"
  curl -fsSL https://tailscale.com/install.sh | sh
  ok "Tailscale installed"
fi

if lspci 2>/dev/null | grep -qi nvidia && ! have nvidia-smi; then
  echo "  This machine has an NVIDIA GPU without its driver. Models on the GPU need it."
  if ask "Install the NVIDIA driver and container toolkit now?"; then
    curl -fsSL "${ROOT_URL}/install/setup-gpu.sh" | bash
  else
    ok "carrying on without GPU support"
  fi
fi

say "Joining the mesh"
tailscale up --login-server "$MESH_LOGIN_SERVER" --authkey "$MESH_PREAUTH_KEY" --hostname "$INSTANCE_ID" --accept-dns=false
MESH_IP="$(tailscale ip -4 | head -n1)"
ok "on the mesh as ${MESH_IP}"
report joined "On the mesh as ${MESH_IP}"

say "Trusting your root's image registry"
mkdir -p /etc/rancher/k3s
cat > /etc/rancher/k3s/registries.yaml <<REGISTRIES
mirrors:
  "${INSTANCE_REGISTRY}":
    endpoint:
      - "http://${INSTANCE_REGISTRY}"
REGISTRIES
systemctl restart k3s
until kubectl get nodes 2>/dev/null | grep -q ' Ready'; do sleep 2; done
ok "k3s pulls from ${INSTANCE_REGISTRY}"

say "Installing your instance (this takes a while the first time)"
PUBLIC_URL="${PUBLIC_URL_OVERRIDE:-http://${MESH_IP}:${NODE_PORT}}"
report installing "Installing the instance" "$PUBLIC_URL"
KEYS_FILE="$(mktemp)"
printf '%s' "$ROOT_PUBLIC_KEYS_B64" | base64 -d > "$KEYS_FILE"
curl -fsSL "$INSTANCE_CHART_URL" -o /tmp/instance-chart.tgz
helm upgrade --install "$RELEASE" /tmp/instance-chart.tgz --namespace "$NAMESPACE" --create-namespace \
  --set image.repository="$INSTANCE_IMAGE" --set image.tag="$INSTANCE_IMAGE_TAG" \
  --set instance.id="$INSTANCE_ID" --set instance.ownerId="$INSTANCE_OWNER_ID" --set instance.rootUrl="$ROOT_URL" \
  --set-file instance.rootPublicKeys="$KEYS_FILE" --set instance.credential="$INSTANCE_CREDENTIAL" \
  --set publicUrl="$PUBLIC_URL" --set backend.nodePort="$NODE_PORT" --set hostDocker="$HOST_DOCKER" \
  --wait --timeout 45m
rm -f "$KEYS_FILE"
report ready "Installed" "$PUBLIC_URL"

say "Done"
echo "  Your instance is running. Sign in at ${ROOT_URL} and it will take you there."
