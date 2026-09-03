#!/usr/bin/env bash
# setup-root.sh — One-time, root-only host setup. The single entry point for everything on
# this platform that needs root, so you only type your password once: Docker CE (Linux), GPU
# container toolkit (calls setup-gpu.sh — no separate sudo invocation needed), the native k3s
# management cluster (Linux, GPU-capable — see scripts/cluster.sh for why it's native instead
# of k3d), trusting the self-hosted Gitea registry as insecure/HTTP, and a scoped passwordless-
# sudo rule so `npm run dev`/`npm run clean-dev` never need to prompt for a password afterward.
#
# Run this BEFORE `bash scripts/setup.sh`, and never run setup.sh itself under sudo:
# setup.sh does npm install / binary downloads / file creation that must run as your
# normal user, or the resulting files end up root-owned and break tools (Vite, etc.)
# that expect to write into them.
#
# Usage: sudo bash scripts/setup-root.sh

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ This script requires root. Run: sudo bash scripts/setup-root.sh"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DETECTED_OS="$(uname -s)"

if [ "$DETECTED_OS" != "Linux" ]; then
  echo "ℹ️  Nothing to do here on ${DETECTED_OS} — Docker is installed via Colima at the user"
  echo "   level (see scripts/setup.sh), and native k3s only runs on Linux (no Linux kernel"
  echo "   on macOS). Just run: bash scripts/setup.sh"
  exit 0
fi

# 1. Docker CE
if ! command -v docker &>/dev/null; then
  echo "🐧 Installing Docker CE..."
  curl -fsSL https://get.docker.com | sh
fi
if command -v systemctl &>/dev/null; then
  systemctl start docker || true
elif command -v service &>/dev/null; then
  service docker start || true
fi
sleep 2
if ! docker info &>/dev/null; then
  echo "❌ Docker daemon did not come up. Check: systemctl status docker"
  exit 1
fi
echo "✅ Docker ready."

# Add the invoking user to the docker group so they can talk to the daemon without
# sudo. Without this every `docker …` command fails with "permission denied while
# trying to connect to the docker API at unix:///var/run/docker.sock" — the socket
# is root:docker 0660 and a user outside the group simply can't reach it.
TARGET_USER="${SUDO_USER:-$(logname 2>/dev/null || true)}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  echo "⚠️  Could not determine the non-root user to add to the docker group (are you running this"
  echo "   via 'sudo bash …' rather than as an actual root login?) — skipping. You'll need to"
  echo "   add yourself manually: sudo usermod -aG docker \$USER"
else
  if id -nG "$TARGET_USER" | grep -qw docker; then
    echo "▶  ${TARGET_USER} is already in the docker group — skipping"
  else
    echo "🔄 Adding ${TARGET_USER} to the docker group..."
    usermod -aG docker "$TARGET_USER"
    echo "✅ ${TARGET_USER} added to the docker group."
    echo ""
    echo "   Group membership doesn't apply to your current shell — pick one:"
    echo "     • Log out and back in (cleanest)"
    echo "     • Run: newgrp docker"
    echo "   Then verify with: docker info"
  fi
fi

# 2. GPU container toolkit (NVIDIA auto-install / AMD detection) — folded in here rather than
#    a separate `sudo bash scripts/setup-gpu.sh` invocation so there's exactly one root-requiring
#    entry point for the whole host setup, not two. Already root (inherited from this script's
#    own sudo), self-detects "no GPU present" and exits 0 cleanly, and is idempotent — safe to
#    fold in unconditionally. Runs before k3s is installed/started below: GPU passthrough config
#    is only read when the cluster starts, so this has to land first or a later manual restart
#    would be needed. Tolerated on failure (warn, don't abort) — a broken GPU driver shouldn't
#    block Docker/k3s/registry/sudoers setup for everything else on this platform that doesn't
#    need a GPU at all.
if ! bash "${ROOT}/scripts/setup-gpu.sh"; then
  echo "⚠️  GPU setup failed or was incomplete — continuing with the rest of host setup."
  echo "   Re-run 'sudo bash scripts/setup-gpu.sh' on its own once you've fixed the issue above."
fi

# 3. Native k3s management cluster — install only, never started here. Starting it is
#    setup.sh's job (npm run setup), now that setup-gpu.sh above has already had its chance to
#    configure GPU passthrough. `npm run dev` only re-starts it later if it's not already
#    running (e.g. after a reboot) — via the scoped sudoers rule below, no prompt needed.
echo "🔄 Installing native k3s management cluster..."
"${ROOT}/scripts/cluster.sh" install provisioning-lunorica

# Ensure model cache directories exist with full read/write permissions so host workers can pre-download
mkdir -p /var/lib/rancher/tabbyapi-model-cache /var/lib/rancher/vllm-model-cache
chmod 1777 /var/lib/rancher/tabbyapi-model-cache /var/lib/rancher/vllm-model-cache

# 4. Trust the self-hosted Gitea registry (scripts/ensure-gitea.sh, deployed later by
#    `npm run dev`) as an insecure/HTTP registry. containerd defaults to HTTPS-only for image
#    pulls — Gitea's registry is plain HTTP (no cluster-internal TLS story yet) — and unlike
#    Kaniko's own build/push step (which takes --insecure/--skip-tls-verify flags directly),
#    a regular pod's image pull has no such flag; it's node-level containerd config only.
#    Confirmed live: without this, every gitapp Deployment sits in ImagePullBackOff forever
#    ("server gave HTTP response to HTTPS client"), even with a correct imagePullSecret.
#
#    Written here (root, before the cluster's first start) rather than by ensure-gitea.sh
#    (unprivileged, runs from `npm run dev`) since containerd only reads registries.yaml at
#    startup — getting the order right avoids a manual restart later, same reasoning as the
#    GPU config note above. The NodePort (31737) is pinned in ensure-gitea.sh's Helm values
#    specifically so this entry doesn't go stale if Gitea is ever reinstalled.
NODE_IP="$(hostname -I | awk '{print $1}')"
if [ -n "$NODE_IP" ]; then
  echo "🔄 Registering Gitea's registry (${NODE_IP}:31737) as an insecure/HTTP registry..."
  mkdir -p /etc/rancher/k3s
  ENTRY_FILE="$(mktemp)"
  printf '  "%s:31737":\n    endpoint:\n      - "http://%s:31737"\n' "$NODE_IP" "$NODE_IP" > "$ENTRY_FILE"
  if [ -f /etc/rancher/k3s/registries.yaml ] && grep -q "${NODE_IP}:31737" /etc/rancher/k3s/registries.yaml; then
    echo "  ▶  Already configured — skipping"
  elif [ -f /etc/rancher/k3s/registries.yaml ] && grep -q "^mirrors:" /etc/rancher/k3s/registries.yaml; then
    # Insert under the existing mirrors: key rather than writing a second one (YAML doesn't
    # allow duplicate top-level keys) — a fresh file (the common case) just gets one written below.
    sed -i "/^mirrors:/r ${ENTRY_FILE}" /etc/rancher/k3s/registries.yaml
  else
    { echo 'mirrors:'; cat "$ENTRY_FILE"; } >> /etc/rancher/k3s/registries.yaml
  fi
  rm -f "$ENTRY_FILE"
else
  echo "⚠️  Could not detect this machine's LAN IP — skipping Gitea registry trust setup."
  echo "   gitapp deployments will hit ImagePullBackOff until this is configured manually"
  echo "   (see scripts/ensure-gitea.sh's comments for the exact fix)."
fi

# 5. Trust the k3s pod bridge (cni0, pod CIDR 10.42.0.0/16 — k3s's fixed default) in firewalld's
#    "trusted" zone. Distros that ship firewalld active by default (Fedora/RHEL family, incl.
#    Nobara) drop pod-to-pod forwarded traffic across the CNI bridge out of the box — host-to-pod
#    still works (different chain), so this is easy to miss until two pods actually need to talk
#    to each other (e.g. Traefik proxying to an app's Service, or an app's web pod reaching its
#    own DB pod). Confirmed live: Traefik got a clean 404 for a non-matching Host header (routing
#    logic fine) but a 502 for a matching one — "Host is unreachable" dialing the backend pod IP
#    from *any* other pod, not just Traefik, while the same IP was reachable fine from the host.
#    Skipped entirely on distros without firewalld (e.g. Debian/Ubuntu, which don't drop this
#    traffic by default) — idempotent and safe to re-run.
if command -v firewall-cmd &>/dev/null && systemctl is-active --quiet firewalld 2>/dev/null; then
  echo "🔄 Trusting the k3s pod bridge (cni0) in firewalld..."
  firewall-cmd --zone=trusted --add-interface=cni0 --permanent >/dev/null 2>&1 || true
  firewall-cmd --zone=trusted --add-source=10.42.0.0/16 --permanent >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1
  echo "✅ firewalld trusts pod-to-pod traffic on cni0 / 10.42.0.0/16."
else
  echo "ℹ️  firewalld not active — skipping pod-bridge trust step (not needed on this distro)."
fi

# 6. Scoped passwordless sudo for the exact commands `npm run dev` / `npm run clean-dev` need
#    afterward (cluster.sh's native_k3s_ensure_running/native_k3s_reset — starting/stopping the
#    k3s service, wiping its one data dir, removing two fixed CNI interfaces, and killing
#    leftover PIDs during a reset). Without this, both commands interactively prompt for a
#    password mid-flow every time the cluster needs to start (e.g. after a reboot) or reset —
#    fine for a one-off, but this platform's whole dev loop is "run one command and it just
#    works." Exact commands/paths only, no wildcards on anything except the PID argument to
#    `kill` (inherently dynamic — pgrep'd fresh each reset) — nothing broader than what
#    cluster.sh already runs as root today.
TARGET_USER="${SUDO_USER:-$(logname 2>/dev/null || true)}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  echo "⚠️  Could not determine the non-root user to grant scoped sudo to (are you running this"
  echo "   via 'sudo bash ...' rather than as an actual root login?) — skipping. dev/clean-dev"
  echo "   will keep prompting for a password when the cluster needs to start or reset."
else
  # type -P, not `command -v` — `kill` is a bash builtin, and `command -v` prefers builtins
  # over PATH, returning the bare word "kill" with no path at all. sudoers requires an
  # absolute path for every command; a bare command name fails `visudo -c` outright. Confirmed
  # live: this was the actual cause of the "Generated sudoers rule failed validation" failure.
  SYSTEMCTL_BIN="$(type -P systemctl)"
  RM_BIN="$(type -P rm)"
  IP_BIN="$(type -P ip)"
  KILL_BIN="$(type -P kill)"
  UNIT="k3s-provisioning-lunorica.service"
  DATA_DIR="/var/lib/rancher/k3s-provisioning-lunorica"

  SUDOERS_FILE="/etc/sudoers.d/provisioning-platform"
  SUDOERS_TMP="$(mktemp)"
  cat > "$SUDOERS_TMP" <<EOF
# Managed by scripts/setup-root.sh — scoped to exactly what cluster.sh needs to start/stop/
# reset the native k3s management cluster without an interactive password prompt on every
# 'npm run dev' / 'npm run clean-dev'. Re-run setup-root.sh to regenerate after editing.
${TARGET_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} start ${UNIT}
${TARGET_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} stop ${UNIT}
${TARGET_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} restart ${UNIT}
${TARGET_USER} ALL=(root) NOPASSWD: ${RM_BIN} -rf ${DATA_DIR}
${TARGET_USER} ALL=(root) NOPASSWD: ${IP_BIN} link delete flannel.1
${TARGET_USER} ALL=(root) NOPASSWD: ${IP_BIN} link delete cni0
${TARGET_USER} ALL=(root) NOPASSWD: ${KILL_BIN} -9 *
EOF

  # Never install an unvalidated sudoers file — a malformed one can break sudo entirely for
  # everyone on the machine. visudo -c checks syntax without touching the real sudoers state.
  if visudo -c -f "$SUDOERS_TMP" >/dev/null 2>&1; then
    install -m 0440 "$SUDOERS_TMP" "$SUDOERS_FILE"
    echo "✅ Scoped passwordless sudo configured for ${TARGET_USER} (${SUDOERS_FILE})"
  else
    echo "❌ Generated sudoers rule failed validation — not installed. dev/clean-dev will keep"
    echo "   prompting for a password. (This is a bug — the generated file should always be"
    echo "   valid; check scripts/setup-root.sh if you see this.)"
  fi
  rm -f "$SUDOERS_TMP"
fi

echo ""
echo "✨ Root-level install complete (Docker, GPU toolkit, k3s, registry trust, firewall, scoped sudo)."
echo "   Next: npm run setup   # WITHOUT sudo — also brings the cluster up"
