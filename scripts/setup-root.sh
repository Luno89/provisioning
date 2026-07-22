#!/usr/bin/env bash
# setup-root.sh — One-time, root-only host setup: Docker CE (Linux) + the native k3s
# management cluster (Linux, GPU-capable — see scripts/cluster.sh for why it's native
# instead of k3d).
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

# 2. Native k3s management cluster — install only, never started here. Starting it is
#    setup.sh's job (npm run setup), after setup-gpu.sh has had a chance to configure GPU
#    passthrough — that config is only read when the cluster starts, so getting the order
#    right here avoids an extra manual restart. `npm run dev` only re-starts it later if
#    it's not already running (e.g. after a reboot), with a single interactive sudo prompt.
echo "🔄 Installing native k3s management cluster..."
"${ROOT}/scripts/cluster.sh" install provisioning-lunorica

echo ""
echo "✨ Root-level install complete. Next:"
echo "     sudo bash scripts/setup-gpu.sh   # only if you have a GPU"
echo "     npm run setup                    # WITHOUT sudo — also brings the cluster up"
