#!/bin/sh
set -eu

ROOT_URL="__ROOT_URL__"
TOKEN=""
YES=0
PUBLIC_URL_OVERRIDE=""
NAMESPACE="nowrinkles"
RELEASE="instance"
NODE_PORT=30320
EDGE_PORT=30321
KUBECONFIG=/etc/rancher/k3s/k3s.yaml
export KUBECONFIG
K3S_VERSION="v1.36.4+k3s1"
K3S_INSTALLER_SHA256=46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad
HELM_VERSION=v3.15.1
HELM_SHA256_AMD64=7b20e7791c04ea71e7fe0cbe11f1a8be4a55a692898b57d9db28f3b0c1d52f11
HELM_SHA256_ARM64=b4c5519b18f01dd2441f5e09497913dc1da1a1eec209033ae792a8d45b9e0e86
TAILSCALE_VERSION=1.104.1
TAILSCALE_SHA256_AMD64=108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528
TAILSCALE_SHA256_ARM64=f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806
DOCKER_VERSION=29.9.0
DOCKER_INSTALL_COMMIT=ada7a567e59b3935bd601bb21e422da50e80e376
DOCKER_INSTALL_SHA256=2b102d809152ea157a59f171319f489d971273b2d26dd7e9a6d1d737ce89289d

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

arch_of() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "this machine is $(uname -m); an instance runs on amd64 or arm64" ;;
  esac
}

fetch_checked() {
  curl -fsSL "$1" -o "$3" || die "could not download $1"
  printf '%s  %s\n' "$2" "$3" | sha256sum -c --quiet - >/dev/null 2>&1 || { rm -f "$3"; die "the download from $1 is not the one Koala pins (its sha256 differs); nothing was installed"; }
}

install_docker() {
  installer="$(mktemp)"
  fetch_checked "https://raw.githubusercontent.com/docker/docker-install/${DOCKER_INSTALL_COMMIT}/install.sh" "$DOCKER_INSTALL_SHA256" "$installer"
  VERSION="$DOCKER_VERSION" sh "$installer"
  rm -f "$installer"
}

install_k3s() {
  installer="$(mktemp)"
  fetch_checked "https://raw.githubusercontent.com/k3s-io/k3s/$(printf '%s' "$K3S_VERSION" | sed 's/+/%2B/')/install.sh" "$K3S_INSTALLER_SHA256" "$installer"
  INSTALL_K3S_VERSION="$K3S_VERSION" sh "$installer"
  rm -f "$installer"
}

install_helm() {
  arch="$(arch_of)"
  if [ "$arch" = amd64 ]; then sha="$HELM_SHA256_AMD64"; else sha="$HELM_SHA256_ARM64"; fi
  work="$(mktemp -d)"
  fetch_checked "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" "$sha" "$work/helm.tar.gz"
  tar -xzf "$work/helm.tar.gz" -C "$work"
  install -m 755 "$work/linux-${arch}/helm" /usr/local/bin/helm
  rm -rf "$work"
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
    -d "{\"status\":\"$1\",\"detail\":\"$2\"$( [ -n "${3:-}" ] && printf ',"url":"%s"' "$3" )$( [ -n "${MESH_IP:-}" ] && printf ',"meshIp":"%s"' "$MESH_IP" )$( [ -n "${4:-}" ] && printf ',"moved":true' )$( [ "$1" = ready ] && [ -n "${INSTANCE_IMAGE_TAG:-}" ] && printf ',"imageTag":"%s"' "$INSTANCE_IMAGE_TAG" )}" "${ROOT_URL}/api/instances/status" >/dev/null 2>&1 || true
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
  install_docker
  HOST_DOCKER=true
  ok "Docker $DOCKER_VERSION installed"
else
  ok "carrying on without Docker — local test clusters will not be available"
fi

if have k3s; then
  ok "k3s is installed"
else
  ask "k3s isn't installed. The instance runs in it. Install k3s?" || die "stopped; an instance needs k3s"
  install_k3s
  ok "k3s $K3S_VERSION installed"
fi

if have helm; then
  ok "helm is installed"
else
  ask "helm isn't installed. It installs the instance. Install helm?" || die "stopped; an instance is installed with helm"
  install_helm
  ok "helm $HELM_VERSION installed"
fi

if have tailscale; then
  ok "Tailscale is installed"
else
  ask "Tailscale isn't installed. It joins this machine to your private mesh. Install it?" || die "stopped; an instance is reached over the mesh"
  install_tailscale
  ok "Tailscale $TAILSCALE_VERSION installed"
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
mkdir -p /etc/rancher/k3s/config.yaml.d
REGISTRIES=/etc/rancher/k3s/registries.yaml
if [ -f "$REGISTRIES" ] && grep -q "\"${INSTANCE_REGISTRY}\":" "$REGISTRIES"; then
  :
else
  ENTRY_FILE="$(mktemp)"
  printf '  "%s":\n    endpoint:\n      - "http://%s"\n' "$INSTANCE_REGISTRY" "$INSTANCE_REGISTRY" > "$ENTRY_FILE"
  if [ -f "$REGISTRIES" ] && grep -q '^mirrors:' "$REGISTRIES"; then
    sed -i "/^mirrors:/r ${ENTRY_FILE}" "$REGISTRIES"
  else
    { echo 'mirrors:'; cat "$ENTRY_FILE"; } >> "$REGISTRIES"
  fi
  rm -f "$ENTRY_FILE"
fi
cat > /etc/rancher/k3s/config.yaml.d/koala-node-ports.yaml <<NODEPORTS
kube-proxy-arg+:
  - nodeport-addresses=127.0.0.1/32,100.64.0.0/10
NODEPORTS
systemctl restart k3s
until kubectl get nodes 2>/dev/null | grep -q ' Ready'; do sleep 2; done
ok "k3s pulls from ${INSTANCE_REGISTRY}"
ok "k3s answers on its node ports only on this machine and the mesh, never on your network"

say "Installing your instance (this takes a while the first time)"
if [ -n "${INSTANCE_DOMAIN:-}" ] && [ -n "${INSTANCE_NAME:-}" ]; then
  DEFAULT_URL="https://${INSTANCE_NAME}.${INSTANCE_DOMAIN}"
  ROUTING="--set routing.name=${INSTANCE_NAME} --set routing.domain=${INSTANCE_DOMAIN} --set edge.nodePort=${EDGE_PORT}"
else
  DEFAULT_URL="http://${MESH_IP}:${NODE_PORT}"
  ROUTING=""
fi
PUBLIC_URL="${PUBLIC_URL_OVERRIDE:-$DEFAULT_URL}"
report installing "Installing the instance" "$PUBLIC_URL"
KEYS_FILE="$(mktemp)"
printf '%s' "$ROOT_PUBLIC_KEYS_B64" | base64 -d > "$KEYS_FILE"
curl -fsSL "$INSTANCE_CHART_URL" -o /tmp/instance-chart.tgz
if [ -n "${INSTANCE_CHART_SHA256:-}" ]; then
  printf '%s  %s\n' "$INSTANCE_CHART_SHA256" /tmp/instance-chart.tgz | sha256sum -c --quiet - >/dev/null 2>&1 \
    || die "the chart Koala's servers sent is not the one they released (its sha256 differs); nothing was installed"
fi
if [ -n "${INSTANCE_IMAGE_DIGEST:-}" ] && ! printf '%s' "$INSTANCE_IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  die "Koala's servers named ${INSTANCE_IMAGE_DIGEST} as the image, which is not a digest; nothing was installed"
fi
MOVE_ARGS=""
if [ "${INSTANCE_MOVE:-}" = yes ]; then
  say "Bringing your instance over from Koala's servers"
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  MOVED_KEYS="$(mktemp)"
  while :; do
    KEYS_CODE="$(curl -sS -H "X-Instance-Id: ${INSTANCE_ID}" -H "Authorization: Bearer ${INSTANCE_CREDENTIAL}" -o "$MOVED_KEYS" -w '%{http_code}' "${ROOT_URL}/api/instances/move/parts/keys" || echo 000)"
    [ "$KEYS_CODE" = 200 ] && break
    case "$KEYS_CODE" in
      502|503|000) echo "  Koala's servers are getting your instance ready (${KEYS_CODE}); asking again"; sleep 5 ;;
      *) die "Koala's servers would not hand over your instance's keys (${KEYS_CODE}): $(cat "$MOVED_KEYS" 2>/dev/null)" ;;
    esac
  done
  kubectl create secret generic "${RELEASE}-keys" -n "$NAMESPACE" --from-env-file="$MOVED_KEYS" --dry-run=client -o yaml \
    | kubectl label --local -f - app.kubernetes.io/managed-by=Helm -o yaml \
    | kubectl annotate --local -f - "meta.helm.sh/release-name=${RELEASE}" "meta.helm.sh/release-namespace=${NAMESPACE}" helm.sh/resource-policy=keep -o yaml \
    | kubectl apply -f - >/dev/null
  rm -f "$MOVED_KEYS"
  ok "your instance's keys are here"
  MOVE_ARGS="--set move.enabled=true"
fi
WAIT="--wait"
[ -n "$MOVE_ARGS" ] && WAIT=
helm upgrade --install "$RELEASE" /tmp/instance-chart.tgz --namespace "$NAMESPACE" --create-namespace \
  --set image.repository="$INSTANCE_IMAGE" --set image.tag="$INSTANCE_IMAGE_TAG" --set-string image.digest="${INSTANCE_IMAGE_DIGEST:-}" \
  --set instance.id="$INSTANCE_ID" --set instance.ownerId="$INSTANCE_OWNER_ID" --set instance.rootUrl="$ROOT_URL" \
  --set-file instance.rootPublicKeys="$KEYS_FILE" --set instance.credential="$INSTANCE_CREDENTIAL" \
  --set publicUrl="$PUBLIC_URL" --set backend.nodePort="$NODE_PORT" --set hostDocker="$HOST_DOCKER" \
  --set mesh.loginServer="$MESH_LOGIN_SERVER" --set mesh.address="$MESH_IP" $ROUTING $MOVE_ARGS \
  $WAIT --timeout 720h
rm -f "$KEYS_FILE"
if [ -n "$MOVE_ARGS" ]; then
  ok "everything came over"
  helm upgrade "$RELEASE" /tmp/instance-chart.tgz --namespace "$NAMESPACE" --reuse-values --set move.enabled=false --wait --timeout 720h
  until curl -fsS -o /dev/null "http://${MESH_IP}:${NODE_PORT}/api/auth/sign-in"; do sleep 3; done
  report ready "Moved here" "$PUBLIC_URL" moved
else
  report ready "Installed" "$PUBLIC_URL"
fi

say "Done"
echo "  Your instance is running. Sign in at ${ROOT_URL} and it will take you there."
