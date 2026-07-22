#!/usr/bin/env bash
# setup-gpu.sh — Install and configure GPU container toolkit for k3d/vLLM workloads.
#
# NVIDIA: Full auto-install (repo → package → configure → restart Docker → verify)
# AMD:    Detection + manual instructions (ROCm setup is distro-specific)
#
# Usage:
#   sudo bash scripts/setup-gpu.sh          # Run with sudo (required for dnf/apt/systemctl)
#   sudo bash scripts/setup-gpu.sh --force  # Skip confirmation prompts
#
# Idempotent: safe to run multiple times. Skips if already configured.

set -euo pipefail

# --force flag kept for backward compatibility (no longer used)

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[setup-gpu]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[setup-gpu]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[setup-gpu]${NC} $*"; }
log_err()   { echo -e "${RED}[setup-gpu]${NC} $*"; }

# ── Retry helper ──
# retry <max_attempts> <command_description> <command...>
retry() {
  local max_attempts="$1"
  shift
  local description="$1"
  shift
  local attempt=0
  local backoff=5

  while [ $attempt -lt "$max_attempts" ]; do
    attempt=$((attempt + 1))
    log_info "Attempting $description (attempt $attempt/$max_attempts)..."
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    if [ $attempt -lt "$max_attempts" ]; then
      log_warn "Failed. Retrying in ${backoff}s..."
      sleep "$backoff"
      backoff=$((backoff * 2))
    fi
  done
  log_err "$description failed after $max_attempts attempts."
  return 1
}

# ── 0. Root check ──
if [ "$(id -u)" -ne 0 ]; then
  log_err "This script requires sudo/root privileges."
  log_info "Run: sudo bash scripts/setup-gpu.sh"
  exit 1
fi

# ── 0b. macOS check ──
# CUDA/ROCm — what vLLM's engine requires — have no macOS driver support at all (NVIDIA
# dropped macOS drivers ~2019; ROCm has never had real macOS support; Apple Silicon has its
# own GPU architecture speaking Metal, not CUDA). This isn't a container/orchestration-layer
# limitation, so there's nothing this script can configure on macOS.
if [ "$(uname -s)" = "Darwin" ]; then
  log_warn "GPU passthrough for vLLM is not supported on macOS — CUDA/ROCm have no macOS"
  log_warn "driver stack, regardless of container runtime. vLLM deployments on macOS run"
  log_warn "in CPU mode."
  exit 0
fi

# ── 1. Detect GPU vendor ──
log_info "Detecting GPU hardware..."

NVIDIA_GPUS=0
AMD_DISCRETE_GPUS=0

if command -v lspci &>/dev/null; then
  NVIDIA_GPUS=$(lspci 2>/dev/null | grep -c "VGA.*NVIDIA" || true)
  # AMD discrete GPUs: exclude CPU iGPUs (Raphael/Granite Ridge are Ryzen APUs)
  AMD_DISCRETE_GPUS=$(lspci 2>/dev/null | grep -iE "VGA.*Advanced Micro Devices" | grep -cvE "Raphael|Granite|Renoir|Vangogh|Cezanne|Picasso" || true)
fi

HAS_NVIDIA_DRIVER=0
HAS_ROCM_DRIVER=0

if command -v nvidia-smi &>/dev/null; then
  HAS_NVIDIA_DRIVER=1
  NVIDIA_NAMES=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)
  log_ok "NVIDIA GPU detected: ${NVIDIA_NAMES}"
fi

if command -v rocminfo &>/dev/null; then
  HAS_ROCM_DRIVER=1
  log_ok "AMD ROCm driver detected"
fi

if [ "$NVIDIA_GPUS" -eq 0 ] && [ "$AMD_DISCRETE_GPUS" -eq 0 ] && [ "$HAS_NVIDIA_DRIVER" -eq 0 ] && [ "$HAS_ROCM_DRIVER" -eq 0 ]; then
  log_warn "No GPU hardware detected. GPU workloads (vLLM) will not work."
  log_info "If you have a GPU, ensure lspci can see it: lspci | grep -iE 'vga|3d'"
  exit 0
fi

# ── 2. Check if already configured ──
check_docker_runtime() {
  local vendor="$1"
  if ! command -v docker &>/dev/null; then
    log_err "Docker is not installed."
    return 1
  fi
  local info
  info=$(docker info 2>/dev/null || true)
  if [ -z "$info" ]; then
    log_err "Docker daemon is not running. Start Docker first: sudo systemctl start docker"
    return 1
  fi
  if [ "$vendor" = "nvidia" ]; then
    echo "$info" | grep -qi "nvidia"
  elif [ "$vendor" = "amd" ]; then
    echo "$info" | grep -qiE "rocm|hip"
  fi
}

# ── 3. NVIDIA auto-install ──
install_nvidia_toolkit() {
  log_info "Checking NVIDIA Container Toolkit status..."

  if check_docker_runtime "nvidia"; then
    log_ok "NVIDIA Container Toolkit is already configured for Docker."

    # Quick verification
    log_info "Verifying GPU passthrough works..."
    if docker run --rm --gpus all ubuntu nvidia-smi &>/dev/null; then
      log_ok "GPU passthrough verified. Docker can pass NVIDIA GPUs to containers."
    else
      log_warn "GPU passthrough test failed. The NVIDIA runtime may need reconfiguration."
      log_info "Running: nvidia-ctk runtime configure --runtime=docker"
      nvidia-ctk runtime configure --runtime=docker 2>/dev/null || true
      log_info "Restarting Docker to apply changes..."
      systemctl restart docker || { log_err "Failed to restart Docker."; return 1; }
      sleep 3
      if docker run --rm --gpus all ubuntu nvidia-smi &>/dev/null; then
        log_ok "GPU passthrough verified after reconfiguration."
      else
        log_warn "GPU passthrough still failing. Check: docker info | grep -i nvidia"
        return 1
      fi
    fi
    return 0
  fi

  log_info "NVIDIA Container Toolkit is not configured. Installing..."

  # Detect package manager
  local pkg_manager=""
  if command -v dnf &>/dev/null; then
    pkg_manager="dnf"
  elif command -v yum &>/dev/null; then
    pkg_manager="yum"
  elif command -v apt-get &>/dev/null; then
    pkg_manager="apt"
  else
    log_err "No supported package manager found (dnf, yum, or apt-get required)."
    return 1
  fi

  # Add NVIDIA repo
  if [ "$pkg_manager" = "dnf" ] || [ "$pkg_manager" = "yum" ]; then
    log_info "Adding NVIDIA Container Toolkit repository..."
    if ! retry 3 "downloading NVIDIA repo" curl -fsSL "https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo" -o /etc/yum.repos.d/nvidia-container-toolkit.repo; then
      log_err "Failed to add NVIDIA repository. Check your internet connection."
      return 1
    fi
    log_ok "NVIDIA repository added."
  elif [ "$pkg_manager" = "apt" ]; then
    log_info "Adding NVIDIA Container Toolkit repository..."
    local distro
    distro=$(. /etc/os-release && echo "${ID}-${VERSION_CODENAME}" 2>/dev/null || echo "")
    if [ -z "$distro" ]; then
      # Fallback: try to detect from lsb_release
      if command -v lsb_release &>/dev/null; then
        distro=$(lsb_release -cs 2>/dev/null || echo "")
        distro="ubuntu-${distro}"
      else
        distro="ubuntu-jammy"
        log_warn "Could not detect distribution. Defaulting to Ubuntu Jammy."
      fi
    fi

    if ! retry 3 "downloading NVIDIA repo list" curl -fsSL "https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list" -o /etc/apt/sources.list.d/nvidia-container-toolkit.list; then
      log_err "Failed to add NVIDIA repository. Check your internet connection."
      return 1
    fi

    if ! retry 3 "downloading NVIDIA GPG key" curl -fsSL "https://nvidia.github.io/libnvidia-container/gpgkey" -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg; then
      log_err "Failed to download NVIDIA GPG key."
      return 1
    fi
    chmod 644 /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

    log_info "Updating package lists..."
    retry 3 "apt-get update" apt-get update
  fi

  # Install package
  log_info "Installing nvidia-container-toolkit..."
  if [ "$pkg_manager" = "dnf" ] || [ "$pkg_manager" = "yum" ]; then
    if ! retry 2 "installing nvidia-container-toolkit" $pkg_manager install -y nvidia-container-toolkit; then
      log_err "Failed to install nvidia-container-toolkit."
      return 1
    fi
  elif [ "$pkg_manager" = "apt" ]; then
    if ! retry 2 "installing nvidia-container-toolkit" apt-get install -y nvidia-container-toolkit; then
      log_err "Failed to install nvidia-container-toolkit."
      return 1
    fi
  fi
  log_ok "nvidia-container-toolkit installed."

  # Configure Docker runtime
  log_info "Configuring Docker NVIDIA runtime..."
  if command -v nvidia-ctk &>/dev/null; then
    nvidia-ctk runtime configure --runtime=docker 2>/dev/null || {
      log_warn "nvidia-ctk configure failed. Attempting manual configuration..."
      # Manual fallback: add nvidia runtime to daemon.json
      local daemon_json="/etc/docker/daemon.json"
      if [ -f "$daemon_json" ]; then
        # Use python to merge JSON if available
        if command -v python3 &>/dev/null; then
          python3 -c "
import json
with open('$daemon_json') as f:
    cfg = json.load(f)
cfg['runtimes'] = cfg.get('runtimes', {})
cfg['runtimes']['nvidia'] = {
    'path': 'nvidia-container-runtime',
    'runtimeArgs': []
}
with open('$daemon_json', 'w') as f:
    json.dump(cfg, f, indent=2)
" 2>/dev/null || true
        fi
      else
        mkdir -p /etc/docker
        echo '{
  "runtimes": {
    "nvidia": {
      "path": "nvidia-container-runtime",
      "runtimeArgs": []
    }
  }
}' > "$daemon_json"
      fi
    }
  else
    log_warn "nvidia-ctk not found. Attempting manual Docker configuration..."
    # Same manual fallback as above
    local daemon_json="/etc/docker/daemon.json"
    if [ -f "$daemon_json" ]; then
      if command -v python3 &>/dev/null; then
        python3 -c "
import json
with open('$daemon_json') as f:
    cfg = json.load(f)
cfg['runtimes'] = cfg.get('runtimes', {})
cfg['runtimes']['nvidia'] = {
    'path': 'nvidia-container-runtime',
    'runtimeArgs': []
}
with open('$daemon_json', 'w') as f:
    json.dump(cfg, f, indent=2)
" 2>/dev/null || true
      fi
    else
      mkdir -p /etc/docker
      echo '{
  "runtimes": {
    "nvidia": {
      "path": "nvidia-container-runtime",
      "runtimeArgs": []
    }
  }
}' > "$daemon_json"
    fi
  fi

  # Restart Docker
  log_info "Restarting Docker to apply NVIDIA runtime..."
  if ! systemctl restart docker; then
    log_err "Failed to restart Docker. Try: sudo systemctl restart docker"
    return 1
  fi

  # Wait for Docker to come back
  log_info "Waiting for Docker to restart..."
  local docker_ready=0
  for i in $(seq 1 30); do
    if docker info &>/dev/null; then
      docker_ready=1
      break
    fi
    sleep 1
  done

  if [ "$docker_ready" -eq 0 ]; then
    log_err "Docker did not restart within 30 seconds."
    return 1
  fi
  log_ok "Docker restarted successfully."

  # Verify
  log_info "Verifying NVIDIA runtime is available..."
  if check_docker_runtime "nvidia"; then
    log_ok "NVIDIA runtime is configured in Docker."
  else
    log_err "NVIDIA runtime is NOT showing in Docker after restart."
    log_info "Check: docker info | grep -i nvidia"
    return 1
  fi

  # Final GPU passthrough test
  log_info "Running GPU passthrough test..."
  if docker run --rm --gpus all ubuntu nvidia-smi &>/dev/null; then
    log_ok "GPU passthrough verified. Docker can pass NVIDIA GPUs to containers."
  else
    log_warn "GPU passthrough test failed. This may be due to missing NVIDIA driver or container image pull issues."
    log_info "You can retry the test manually: docker run --rm --gpus all ubuntu nvidia-smi"
  fi

  return 0
}

# ── 4. AMD instructions ──
show_amd_instructions() {
  log_info "AMD GPU detected. ROCm setup requires manual installation."
  echo ""
  echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}  AMD ROCm Setup Instructions${NC}"
  echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  1. Install ROCm driver for your distribution:"
  echo "     https://rocm.docs.amd.com/en/latest/deploy/linux/quick_start.html"
  echo ""
  echo "  2. Install ROCm Container Toolkit:"
  echo "     https://rocm.docs.amd.com/en/latest/deploy/linux/container.html"
  echo ""
  echo "  3. Configure Docker to use ROCm runtime, then restart:"
  echo "     sudo systemctl restart docker"
  echo ""
  echo "  4. Verify:"
  echo "     rocminfo"
  echo "     docker run --rm --device /dev/kfd --device /dev/dri rocm/dev-ubuntu:latest rocminfo"
  echo ""
  echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
  echo ""
}

# ── 4b. Native k3s + GPU: nothing to do here ──
# k3s auto-detects nvidia-container-runtime on the host and registers it as an available
# containerd runtime by itself (confirmed via "Found nvidia container runtime at
# /usr/bin/nvidia-container-runtime" in its own startup log — zero config needed). We used to
# hand-edit the generated containerd config here to force it as the node-wide default runtime;
# that turned out fragile two different ways (a silently-dropped duplicate `imports` key, then
# a hard containerd crash from redeclaring a TOML table k3s already declares) and wasn't even
# necessary. GPU pods opt in via `runtimeClassName: nvidia` instead — see
# k8s/gpu-device-plugin/nvidia-runtimeclass.yaml (applied by the backend alongside the device
# plugin, InfrastructureService.installGpuDevicePlugin) and vllm.ts's pod spec. Nothing for
# this script to configure on the native-k3s side at all.

# ── 5. Main ──
log_info "GPU Setup Script"
echo ""

NVIDIA_DONE=0
AMD_DONE=0

if [ "$HAS_NVIDIA_DRIVER" -eq 1 ] || [ "$NVIDIA_GPUS" -gt 0 ]; then
  if install_nvidia_toolkit; then
    NVIDIA_DONE=1
  else
    log_err "NVIDIA toolkit setup failed."
  fi
  echo ""
fi

if [ "$HAS_ROCM_DRIVER" -eq 1 ] || [ "$AMD_DISCRETE_GPUS" -gt 0 ]; then
  show_amd_instructions
  echo ""
fi

# ── Summary ──
if [ "$NVIDIA_DONE" -eq 1 ]; then
  log_ok "GPU setup complete. You can now deploy vLLM workloads with NVIDIA GPUs."
  exit 0
elif [ "$HAS_NVIDIA_DRIVER" -eq 1 ] || [ "$NVIDIA_GPUS" -gt 0 ]; then
  log_err "NVIDIA GPU setup failed. Fix the issues above and re-run: sudo bash scripts/setup-gpu.sh"
  exit 1
else
  log_info "No NVIDIA GPUs detected. If you have AMD GPUs, follow the instructions above."
  exit 0
fi