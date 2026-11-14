#!/bin/sh
set -eu

KOALA_URL="__KOALA_URL__"
CODE=""
YES=0
FOLDER=""
SERVICE=1
CLUSTER=1
ADAPTERS=""
TAILSCALE_VERSION=1.104.1
NODE_VERSION=22.23.4
NODE_SHA256_LINUX_X64=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
NODE_SHA256_LINUX_ARM64=f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9
NODE_SHA256_DARWIN_ARM64=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428
NODE_SHA256_DARWIN_X64=efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819
TAILSCALE_SHA256_AMD64=108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528
TAILSCALE_SHA256_ARM64=f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806
K3S_VERSION="v1.36.4+k3s1"
K3S_INSTALLER_SHA256=46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad
K3S_SHA256_AMD64=835873f37245fc615f547a2fe2af9402a347875f13fa64a1f136de644955ea3f
K3S_SHA256_ARM64=c920706346d5ad4e5cd3c7bf1bb09ce71ebe07fec829e513e40f1caf98aed8bb
K3S_MIRROR="https://github.com/k3s-io/k3s/releases/download"
K3S_MARKER=/etc/koala/machine-k3s
NVIDIA_TOOLKIT_VERSION=1.20.1-1
NVIDIA_KEY_SHA256=c880576d6cf75a48e5027a871bac70fd0421ab07d2b55f30877b21f1c87959c9
NVIDIA_REPO=https://nvidia.github.io/libnvidia-container
NVIDIA_CDI_HOOK=/usr/bin/nvidia-cdi-hook
NVIDIA_RUNTIME=/usr/bin/nvidia-container-runtime
NVIDIA_CDI_MARKER=/etc/koala/nvidia-cdi
HELM_VERSION=v3.15.1
HELM_SHA256_AMD64=7b20e7791c04ea71e7fe0cbe11f1a8be4a55a692898b57d9db28f3b0c1d52f11
HELM_SHA256_ARM64=b4c5519b18f01dd2441f5e09497913dc1da1a1eec209033ae792a8d45b9e0e86

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --folder) FOLDER="$2"; shift ;;
    --no-service) SERVICE=0 ;;
    --no-cluster) CLUSTER=0 ;;
    --adapters) ADAPTERS="$2"; shift ;;
    --url) KOALA_URL="$2"; shift ;;
    --k3s-mirror) K3S_MIRROR="$2"; shift ;;
    --) ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) CODE="$1" ;;
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
json() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

case "$ADAPTERS" in
  "") if [ "$YES" = 1 ]; then ADAPTERS=all; else ADAPTERS=ask; fi ;;
  ask|all|none) ;;
  *) die "--adapters takes ask, all or none" ;;
esac
[ -n "$CODE" ] || die "usage: curl -fsSL ${KOALA_URL}/machine.sh | sh -s -- <code from My Machines>"
[ "$(id -u)" != 0 ] || die "run this as yourself, not root: the agents it finds are yours"
sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

install_tailscale() {
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64; sha="$TAILSCALE_SHA256_AMD64" ;;
    aarch64|arm64) arch=arm64; sha="$TAILSCALE_SHA256_ARM64" ;;
    *) die "this machine is $(uname -m); install Tailscale from https://tailscale.com/download, then run this again" ;;
  esac
  work="$(mktemp -d)"
  curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${arch}.tgz" -o "$work/tailscale.tgz" || die "could not download Tailscale"
  [ "$(sha256_of "$work/tailscale.tgz")" = "$sha" ] || { rm -rf "$work"; die "the Tailscale download is not the one Koala pins (its sha256 differs); nothing was installed"; }
  tar -xzf "$work/tailscale.tgz" -C "$work"
  from="$work/tailscale_${TAILSCALE_VERSION}_${arch}"
  sudo install -m 755 "$from/tailscale" /usr/bin/tailscale
  sudo install -m 755 "$from/tailscaled" /usr/sbin/tailscaled
  sudo install -m 644 "$from/systemd/tailscaled.service" /etc/systemd/system/tailscaled.service
  [ -f /etc/default/tailscaled ] || sudo install -m 644 "$from/systemd/tailscaled.defaults" /etc/default/tailscaled
  rm -rf "$work"
  sudo systemctl daemon-reload
  sudo systemctl enable --now tailscaled >/dev/null 2>&1
}

install_node() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64) platform=linux-x64; sha="$NODE_SHA256_LINUX_X64" ;;
    Linux-aarch64|Linux-arm64) platform=linux-arm64; sha="$NODE_SHA256_LINUX_ARM64" ;;
    Darwin-arm64) platform=darwin-arm64; sha="$NODE_SHA256_DARWIN_ARM64" ;;
    Darwin-x86_64) platform=darwin-x64; sha="$NODE_SHA256_DARWIN_X64" ;;
    *) die "this machine is $(uname -s) $(uname -m), which Koala's machine agent does not run on yet" ;;
  esac
  NODE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/koala/node-v${NODE_VERSION}"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    work="$(mktemp -d)"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${platform}.tar.gz" -o "$work/node.tar.gz" || { rm -rf "$work"; die "could not download Node.js"; }
    [ "$(sha256_of "$work/node.tar.gz")" = "$sha" ] || { rm -rf "$work"; die "the Node.js download is not the one Koala pins (its sha256 differs); nothing was installed"; }
    tar -xzf "$work/node.tar.gz" -C "$work"
    mkdir -p "$(dirname "$NODE_DIR")"
    rm -rf "$NODE_DIR"
    mv "$work/node-v${NODE_VERSION}-${platform}" "$NODE_DIR"
    rm -rf "$work"
  fi
  PATH="$NODE_DIR/bin:$PATH"
  export PATH
  NODE_BIN="$NODE_DIR/bin/node"
}

have curl || die "curl is needed"
have tar || die "tar is needed"

say "Checking this machine"
install_node
ok "Node.js $("$NODE_BIN" -v) of Koala's own, in $NODE_DIR; your own Node.js is left as it is"

if [ -z "$FOLDER" ]; then
  FOLDER="$HOME/koala"
  if [ "$YES" != 1 ]; then
    printf '  Which folder may Koala work in? [%s] ' "$FOLDER"
    read -r answer < /dev/tty || answer=""
    [ -n "$answer" ] && FOLDER="$answer"
  fi
fi
case "$FOLDER" in "~"*) FOLDER="$HOME${FOLDER#\~}" ;; esac
mkdir -p "$FOLDER"
FOLDER=$(cd "$FOLDER" && pwd)
HOME_DIR=$(cd "$HOME" && pwd)
case "$HOME_DIR/" in "$FOLDER"/*) die "Koala works in a folder of its own, never $FOLDER, which holds everything else on this machine: pick a folder inside it, like $HOME_DIR/koala" ;; esac
[ "$FOLDER" = "/" ] && die "Koala works in a folder of its own, never /: pick a folder inside your home, like $HOME_DIR/koala"
ok "Koala works in $FOLDER, and nowhere else"

say "Joining ${KOALA_URL}"
JOINED=$(mktemp)
MESH_KEY_FILE=$(mktemp)
trap 'rm -f "$JOINED" "$MESH_KEY_FILE"' EXIT
HOST=$(hostname 2>/dev/null || uname -n)
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/koala/machine.json"
REPLACES=""
[ -f "$CONFIG" ] && REPLACES=$(node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token || "")) } catch {}' "$CONFIG")
OS="$(uname -s) $(uname -m)"
HTTP_CODE=$(printf '%s' "{\"code\":\"$(json "$CODE")\",\"hostname\":\"$(json "$HOST")\",\"rootDir\":\"$(json "$FOLDER")\",\"os\":\"$(json "$OS")\",\"replaces\":\"$(json "$REPLACES")\"}" \
  | curl -sS -o "$JOINED" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @- \
  "${KOALA_URL}/api/machines/join")
[ "$HTTP_CODE" = 200 ] || die "Koala refused this machine (${HTTP_CODE}): $(cat "$JOINED")"
joined() { node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).env?.[process.argv[2]]; process.stdout.write(typeof v === "string" ? v : "")' "$JOINED" "$1"; }
KOALA_ROOT_URL=$(joined KOALA_ROOT_URL)
KOALA_DEVICE_ID=$(joined KOALA_DEVICE_ID)
KOALA_DEVICE_TOKEN=$(joined KOALA_DEVICE_TOKEN)
KOALA_ROOT_DIR=$(joined KOALA_ROOT_DIR)
KOALA_AGENT_SHA256=$(joined KOALA_AGENT_SHA256)
KOALA_REGISTRY=$(joined KOALA_REGISTRY)
MESH_LOGIN_SERVER=$(joined MESH_LOGIN_SERVER)
joined MESH_AUTH_KEY > "$MESH_KEY_FILE"
rm -f "$JOINED"
ok "this machine is ${HOST} on your account"

if [ -n "${MESH_LOGIN_SERVER:-}" ]; then
  say "Joining your private network"
  if ! have tailscale; then
    [ "$(uname -s)" = Linux ] || die "install Tailscale from https://tailscale.com/download, then run this again: Koala reaches this machine through it, privately"
    ask "Tailscale isn't installed. Koala reaches this machine through it, privately. Install it?" || die "stopped: this machine needs the private network to take work"
    install_tailscale
    ok "Tailscale $TAILSCALE_VERSION installed"
  fi
  sudo tailscale up --login-server="$MESH_LOGIN_SERVER" --auth-key="file:$MESH_KEY_FILE" --accept-dns=false
  rm -f "$MESH_KEY_FILE"
  ok "on the private network as $(tailscale ip -4 | head -n1)"
fi

install_k3s() {
  person=$(id -un)
  group=$(id -gn)
  mesh_ip=$(tailscale ip -4 2>/dev/null | head -n1 || true)
  installer=$(mktemp)
  curl -fsSL "https://raw.githubusercontent.com/k3s-io/k3s/$(printf '%s' "$K3S_VERSION" | sed 's/+/%2B/')/install.sh" -o "$installer"
  [ "$(sha256_of "$installer")" = "$K3S_INSTALLER_SHA256" ] || { rm -f "$installer"; die "the k3s installer downloaded is not the one Koala pins (its sha256 differs); nothing was installed"; }
  sudo mkdir -p /etc/rancher/k3s/config.yaml.d /etc/koala /usr/local/lib/koala /etc/systemd/system/k3s.service.d
  {
    printf 'disable:\n  - traefik\n  - servicelb\n'
    [ -n "$mesh_ip" ] && printf 'tls-san:\n  - %s\n' "$mesh_ip"
    printf 'write-kubeconfig-mode: "0640"\nwrite-kubeconfig-group: %s\n' "$group"
  } | sudo tee /etc/rancher/k3s/config.yaml >/dev/null
  printf 'kube-proxy-arg+:\n  - nodeport-addresses=127.0.0.1/32,100.64.0.0/10\n' | sudo tee /etc/rancher/k3s/config.yaml.d/koala-node-ports.yaml >/dev/null
  if [ -n "$KOALA_REGISTRY" ] && ! sudo grep -qs "\"${KOALA_REGISTRY}\":" /etc/rancher/k3s/registries.yaml; then
    entry=$(printf '  "%s":\n    endpoint:\n      - "http://%s"\n' "$KOALA_REGISTRY" "$KOALA_REGISTRY")
    if sudo grep -qs '^mirrors:' /etc/rancher/k3s/registries.yaml; then
      printf '%s\n' "$entry" | sudo sed -i '/^mirrors:/r /dev/stdin' /etc/rancher/k3s/registries.yaml
    else
      printf 'mirrors:\n%s\n' "$entry" | sudo tee -a /etc/rancher/k3s/registries.yaml >/dev/null
    fi
  fi
  sudo tee /usr/local/lib/koala/k3s-firewall.sh >/dev/null <<'FIREWALL'
#!/bin/sh
set -e
for tables in iptables ip6tables; do
  command -v "$tables" >/dev/null 2>&1 || continue
  "$tables" -N KOALA-MACHINE 2>/dev/null || "$tables" -F KOALA-MACHINE
  "$tables" -A KOALA-MACHINE -i lo -j RETURN
  "$tables" -A KOALA-MACHINE -i tailscale0 -j RETURN
  [ "$tables" = iptables ] && "$tables" -A KOALA-MACHINE -s 10.42.0.0/16 -j RETURN
  "$tables" -A KOALA-MACHINE -j DROP
  "$tables" -C INPUT -p tcp -m multiport --dports 6443,10250 -j KOALA-MACHINE 2>/dev/null || "$tables" -I INPUT -p tcp -m multiport --dports 6443,10250 -j KOALA-MACHINE
done
FIREWALL
  sudo chmod 755 /usr/local/lib/koala/k3s-firewall.sh
  sudo tee /usr/local/lib/koala/machine-uninstall.sh >/dev/null <<'UNINSTALL'
#!/bin/sh
[ -x /usr/local/bin/k3s-uninstall.sh ] && /usr/local/bin/k3s-uninstall.sh
for tables in iptables ip6tables; do
  command -v "$tables" >/dev/null 2>&1 || continue
  while "$tables" -D INPUT -p tcp -m multiport --dports 6443,10250 -j KOALA-MACHINE 2>/dev/null; do :; done
  "$tables" -F KOALA-MACHINE 2>/dev/null && "$tables" -X KOALA-MACHINE 2>/dev/null
done
rm -rf /etc/systemd/system/k3s.service.d/koala-firewall.conf /etc/koala/machine-k3s /usr/local/lib/koala/k3s-firewall.sh /etc/sudoers.d/koala-k3s
if [ -f /etc/koala/nvidia-cdi ]; then
  systemctl disable --now nvidia-cdi-refresh.path
  case "$(cat /etc/koala/nvidia-cdi)" in
    apt) apt-get remove -y nvidia-container-toolkit nvidia-container-toolkit-base libnvidia-container-tools libnvidia-container1 && rm -f /etc/apt/sources.list.d/koala-nvidia-container-toolkit.list /usr/share/keyrings/koala-nvidia-container-toolkit.asc ;;
    dnf) dnf remove -y nvidia-container-toolkit nvidia-container-toolkit-base libnvidia-container-tools libnvidia-container1 && rm -f /etc/yum.repos.d/koala-nvidia-container-toolkit.repo /etc/pki/rpm-gpg/KOALA-NVIDIA-CONTAINER-TOOLKIT ;;
  esac
  rm -f /etc/koala/nvidia-cdi /var/run/cdi/nvidia.yaml
fi
systemctl daemon-reload
rm -f /usr/local/lib/koala/machine-uninstall.sh
UNINSTALL
  sudo chmod 755 /usr/local/lib/koala/machine-uninstall.sh
  printf '[Service]\nExecStartPre=/usr/local/lib/koala/k3s-firewall.sh\n' | sudo tee /etc/systemd/system/k3s.service.d/koala-firewall.conf >/dev/null
  if [ ! -x /usr/local/bin/k3s ] || [ "$(cat "$K3S_MARKER" 2>/dev/null)" != "$K3S_VERSION" ]; then
    case "$(uname -m)" in
      aarch64|arm64) file=k3s-arm64; sha="$K3S_SHA256_ARM64" ;;
      *) file=k3s; sha="$K3S_SHA256_AMD64" ;;
    esac
    binary=$(mktemp)
    curl -fsSL "$K3S_MIRROR/$(printf '%s' "$K3S_VERSION" | sed 's/+/%2B/')/$file" -o "$binary" || { rm -f "$installer" "$binary"; die "could not download k3s $K3S_VERSION"; }
    [ "$(sha256_of "$binary")" = "$sha" ] || { rm -f "$installer" "$binary"; die "the k3s downloaded is not the one Koala pins (its sha256 differs); nothing was installed"; }
    sudo install -m 755 "$binary" /usr/local/bin/k3s
    rm -f "$binary"
    sudo env INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_SKIP_START=true INSTALL_K3S_SKIP_ENABLE=true sh "$installer" >/dev/null
  fi
  rm -f "$installer"
  sudo systemctl daemon-reload
  systemctl_bin=$(command -v systemctl)
  rule="$person ALL=(root) NOPASSWD: $systemctl_bin start k3s, $systemctl_bin stop k3s, /usr/local/bin/k3s-killall.sh, /usr/local/lib/koala/machine-uninstall.sh"
  rules=$(mktemp)
  printf '%s\n' "$rule" > "$rules"
  sudo visudo -cf "$rules" >/dev/null || { rm -f "$rules"; die "the sudo rule for starting k3s did not check out; nothing was changed in sudoers"; }
  sudo install -m 440 -o root -g root "$rules" /etc/sudoers.d/koala-k3s
  rm -f "$rules"
  printf '%s\n' "$K3S_VERSION" | sudo tee "$K3S_MARKER" >/dev/null
}

os_ids() {
  . /etc/os-release
  printf '%s %s' "${ID:-}" "${ID_LIKE:-}"
}

package_family() {
  [ -r /etc/os-release ] || { echo none; return 0; }
  case " $(os_ids) " in
    *" debian "*|*" ubuntu "*) echo apt ;;
    *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*|*" amzn "*) echo dnf ;;
    *) echo none ;;
  esac
}

install_nvidia_cdi() {
  family=$(package_family)
  if [ "$family" = none ]; then
    echo "  NVIDIA's CDI support is not offered on this system, so its GPUs are not used. Install nvidia-container-toolkit $NVIDIA_TOOLKIT_VERSION as https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html says, enable nvidia-cdi-refresh.path, then run this command again."
    return 0
  fi
  key=$(mktemp)
  curl -fsSL "$NVIDIA_REPO/gpgkey" -o "$key" || { rm -f "$key"; die "could not download NVIDIA's package signing key; nothing was installed"; }
  [ "$(sha256_of "$key")" = "$NVIDIA_KEY_SHA256" ] || { rm -f "$key"; die "NVIDIA's package signing key downloaded is not the one Koala pins (its sha256 differs); nothing was installed"; }
  if [ "$family" = apt ]; then
    sudo install -m 644 "$key" /usr/share/keyrings/koala-nvidia-container-toolkit.asc
    printf 'deb [signed-by=/usr/share/keyrings/koala-nvidia-container-toolkit.asc] %s/stable/deb/$(ARCH) /\n' "$NVIDIA_REPO" | sudo tee /etc/apt/sources.list.d/koala-nvidia-container-toolkit.list >/dev/null
    sudo apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/koala-nvidia-container-toolkit.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >/dev/null
    sudo apt-get install -y "nvidia-container-toolkit=$NVIDIA_TOOLKIT_VERSION" "nvidia-container-toolkit-base=$NVIDIA_TOOLKIT_VERSION" "libnvidia-container-tools=$NVIDIA_TOOLKIT_VERSION" "libnvidia-container1=$NVIDIA_TOOLKIT_VERSION" >/dev/null
  else
    sudo install -m 644 "$key" /etc/pki/rpm-gpg/KOALA-NVIDIA-CONTAINER-TOOLKIT
    printf '[koala-nvidia-container-toolkit]\nname=NVIDIA Container Toolkit, added by Koala\nbaseurl=%s/stable/rpm/$basearch\nrepo_gpgcheck=1\ngpgcheck=0\nenabled=1\ngpgkey=file:///etc/pki/rpm-gpg/KOALA-NVIDIA-CONTAINER-TOOLKIT\n' "$NVIDIA_REPO" | sudo tee /etc/yum.repos.d/koala-nvidia-container-toolkit.repo >/dev/null
    sudo dnf install -y "nvidia-container-toolkit-$NVIDIA_TOOLKIT_VERSION" "nvidia-container-toolkit-base-$NVIDIA_TOOLKIT_VERSION" "libnvidia-container-tools-$NVIDIA_TOOLKIT_VERSION" "libnvidia-container1-$NVIDIA_TOOLKIT_VERSION" >/dev/null
  fi
  rm -f "$key"
  sudo systemctl enable --now nvidia-cdi-refresh.path >/dev/null
  sudo systemctl start nvidia-cdi-refresh.service
  printf '%s\n' "$family" | sudo tee "$NVIDIA_CDI_MARKER" >/dev/null
  ok "NVIDIA's CDI support $NVIDIA_TOOLKIT_VERSION installed from NVIDIA's own repository; apps here can be given this machine's NVIDIA GPUs"
}

offer_nvidia_cdi() {
  have nvidia-smi || return 0
  if [ -x "$NVIDIA_CDI_HOOK" ] && [ -x "$NVIDIA_RUNTIME" ]; then
    ok "NVIDIA's CDI support is already installed here; Koala uses it as it is"
    return 0
  fi
  if ask "This machine has an NVIDIA GPU. Install NVIDIA's CDI support (nvidia-container-toolkit $NVIDIA_TOOLKIT_VERSION, from NVIDIA's own repository) so apps here can use it?"; then
    install_nvidia_cdi
  else
    echo "  without it Koala runs apps here on CPU only; run this command again to add it"
  fi
}

if [ "$CLUSTER" = 1 ] && [ "$(uname -s)" = Linux ]; then
  say "This machine's own cluster"
  if [ -x /usr/local/bin/k3s ] && [ ! -f "$K3S_MARKER" ]; then
    echo "  this machine already runs k3s of its own; Koala leaves it alone and runs no apps here"
  elif ask "Koala runs apps and workspaces here in k3s, started only while there is work and stopped after. Install k3s $K3S_VERSION (asks for sudo once)?"; then
    install_k3s
    ok "k3s $K3S_VERSION installed, stopped until Koala has work here; it answers only on this machine and your private network"
    offer_nvidia_cdi
  else
    echo "  without it Koala runs only your coding agents here; run this command again to add it"
  fi
fi

install_helm() {
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64; sha="$HELM_SHA256_ARM64" ;;
    *) arch=amd64; sha="$HELM_SHA256_AMD64" ;;
  esac
  work=$(mktemp -d)
  curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" -o "$work/helm.tar.gz" || { rm -rf "$work"; die "could not download helm"; }
  [ "$(sha256_of "$work/helm.tar.gz")" = "$sha" ] || { rm -rf "$work"; die "the helm downloaded is not the one Koala pins (its sha256 differs); nothing was installed"; }
  tar -xzf "$work/helm.tar.gz" -C "$work"
  mkdir -p "$KOALA_BIN"
  install -m 755 "$work/linux-${arch}/helm" "$KOALA_BIN/helm"
  rm -rf "$work"
}

KOALA_BIN="${XDG_DATA_HOME:-$HOME/.local/share}/koala/bin"
if [ -f "$K3S_MARKER" ] && ! "$KOALA_BIN/helm" version --short 2>/dev/null | grep -q "^${HELM_VERSION}+"; then
  install_helm
  ok "helm $HELM_VERSION installed in $KOALA_BIN, for putting Koala here"
fi

say "Installing the machine agent"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/koala/machine"
NEXT_DIR="$DATA_DIR.next"
rm -rf "$NEXT_DIR"
mkdir -p "$NEXT_DIR"
BUNDLE=$(mktemp)
curl -fsSL "${KOALA_URL}/api/machines/agent.tgz" -o "$BUNDLE"
[ -n "$KOALA_AGENT_SHA256" ] || { rm -f "$BUNDLE"; die "Koala did not say what the machine agent's checksum should be; nothing was installed"; }
GOT=$(sha256_of "$BUNDLE")
[ "$GOT" = "$KOALA_AGENT_SHA256" ] || { rm -f "$BUNDLE"; die "the machine agent Koala sent is not the one it built (its sha256 differs); nothing was installed"; }
tar -xzf "$BUNDLE" -C "$NEXT_DIR"
rm -f "$BUNDLE"
(cd "$NEXT_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null)
printf '%s\n' "$KOALA_AGENT_SHA256" > "$NEXT_DIR/bundle.sha256"
rm -rf "$DATA_DIR"
mv "$NEXT_DIR" "$DATA_DIR"
ok "installed in $DATA_DIR"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/koala"
mkdir -p "$CONFIG_DIR"
CONFIG="$CONFIG_DIR/machine.json"
(
  umask 077
  cat > "$CONFIG" <<EOF
{
  "rootUrl": "$(json "$KOALA_ROOT_URL")",
  "token": "$(json "$KOALA_DEVICE_TOKEN")",
  "deviceId": "$(json "$KOALA_DEVICE_ID")",
  "rootDir": "$(json "$KOALA_ROOT_DIR")"
}
EOF
)
chmod 600 "$CONFIG"
ok "its settings are in $CONFIG, readable only by you"

say "Coding agents on this machine"
(cd "$FOLDER" && "$NODE_BIN" "$DATA_DIR/agent.mjs" agents --adapters "$ADAPTERS") || echo "  Koala could not look for coding agents now; it looks again each time this machine connects."

START="\"$NODE_BIN\" \"$DATA_DIR/agent.mjs\""
if [ "$SERVICE" = 1 ] && [ "$(uname -s)" = Linux ] && have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  say "Starting it, now and whenever you log in"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/koala-machine.service" <<EOF
[Unit]
Description=Koala machine agent
After=network-online.target

[Service]
ExecStart=$NODE_BIN $DATA_DIR/agent.mjs
WorkingDirectory=$FOLDER
Environment=PATH=$PATH
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable koala-machine.service >/dev/null 2>&1
  systemctl --user restart koala-machine.service
  ok "running as the koala-machine service (journalctl --user -u koala-machine to read it)"
  if loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
    ok "it starts when this machine starts, without you logging in"
  else
    echo "  It runs while you are logged in. To keep it running after a restart without logging in: sudo loginctl enable-linger $(id -un)"
  fi
elif [ "$SERVICE" = 1 ] && [ "$(uname -s)" = Darwin ]; then
  say "Starting it, now and whenever you log in"
  PLIST="$HOME/Library/LaunchAgents/dev.koala.machine.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.koala.machine</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DATA_DIR/agent.mjs</string></array>
  <key>WorkingDirectory</key><string>$FOLDER</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/koala-machine.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/koala-machine.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  ok "running as dev.koala.machine (its log is ~/Library/Logs/koala-machine.log)"
else
  say "Start it with"
  echo "  $START"
fi

say "Done"
echo "  This machine shows on My Machines in a moment, with the coding agents it found."
