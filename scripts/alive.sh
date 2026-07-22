#!/usr/bin/env bash
# alive — Fast, color-coded environment diagnostics to verify system readiness.
set -euo pipefail

ROOT="$(cd "$(dirname -- "$0")/.." && pwd)"

CLUSTER="${1:-provisioning-lunorica}"
echo "🔍 Starting Infrastructure Diagnostics for cluster: ${CLUSTER}..."

# Helper for formatted output
print_ok() {
  echo -e "  ✅  \033[32m$1\033[0m"
}

print_fail() {
  echo -e "  ❌  \033[31m$1\033[0m"
  if [ -n "${2:-}" ]; then
    echo -e "      \033[33mFix: $2\033[0m"
  fi
}

FAILED=0

# 1. Check Docker Daemon
if ! docker info >/dev/null 2>&1; then
  print_fail "Docker Daemon is not running" "Start Docker Desktop or run 'colima start'"
  FAILED=1
else
  print_ok "Docker Daemon is responsive"
fi

# 2. Resolve K3D binary
K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

# Check K3d Cluster existence
if [ $FAILED -eq 0 ]; then
  if ! "$K3D" cluster list "${CLUSTER}" >/dev/null 2>&1; then
    print_fail "K3d Cluster '${CLUSTER}' does not exist" "Run 'npm run dev' to initialize the development cluster, or start E2E setup."
    FAILED=1
  else
    print_ok "K3d Cluster '${CLUSTER}' exists"
  fi
else
  print_fail "Skipped K3d Cluster check (Docker is down)"
fi

# 3. Resolve KUBECTL binary & Check Kubernetes Nodes
KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi

if [ $FAILED -eq 0 ]; then
  CONTEXT="k3d-${CLUSTER}"
  if ! "$KUBECTL" get nodes --context "${CONTEXT}" -o json >/dev/null 2>&1; then
    print_fail "Kubernetes API server for '${CLUSTER}' is unresponsive" "Verify the cluster containers are running in Docker."
    FAILED=1
  else
    # Parse nodes to check for Ready status
    NODES_READY=$("$KUBECTL" get nodes --context "${CONTEXT}" -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    if [[ "$NODES_READY" =~ "True" ]]; then
      print_ok "Kubernetes control plane has at least one Ready node"
    else
      print_fail "Kubernetes cluster does not have any Ready nodes" "Check container resource limits or run 'colima restart'."
      FAILED=1
    fi
  fi
else
  print_fail "Skipped Kubernetes API check"
fi

# 4. Check Temporal Server Health
if true &>/dev/null </dev/tcp/127.0.0.1/7233; then
  print_ok "Temporal server is listening on port 7233"
else
  print_fail "Temporal server is not running on port 7233" "Run 'docker compose -f docker-compose.temporal.yml up -d' to start Temporal."
  FAILED=1
fi

# 5. Check Worker Health (In-Cluster Pod or Host Processes)
if [ $FAILED -eq 0 ]; then
  CONTEXT="k3d-${CLUSTER}"
  IN_CLUSTER_OK=0
  
  if [ "${CLUSTER}" = "provisioning-lunorica" ] && "$KUBECTL" get deployment provisioning-worker --context "${CONTEXT}" >/dev/null 2>&1; then
    AVAILABLE_REPLICAS=$("$KUBECTL" get deployment provisioning-worker --context "${CONTEXT}" -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo "0")
    if [ "${AVAILABLE_REPLICAS:-0}" -gt 0 ]; then
      IN_CLUSTER_OK=1
      print_ok "In-cluster worker deployment is running and healthy"
    fi
  fi

  if [ $IN_CLUSTER_OK -eq 0 ]; then
    # Check if host workers are running
    HOST_WORKER_UP=0
    CLUSTER_WORKER_UP=0
    if pgrep -f "worker-host" >/dev/null 2>&1; then
      HOST_WORKER_UP=1
    fi
    if pgrep -f "worker-cluster" >/dev/null 2>&1; then
      CLUSTER_WORKER_UP=1
    fi

    if [ $HOST_WORKER_UP -eq 1 ] && [ $CLUSTER_WORKER_UP -eq 1 ]; then
      print_ok "Both host and cluster workers are running on the host (dev/test mode)"
    elif [ $HOST_WORKER_UP -eq 1 ]; then
      print_fail "Only Host Worker is running on the host; Cluster Worker is missing" "Run 'npm run dev' or 'npm run dev:worker:cluster' to start the cluster worker."
      FAILED=1
    elif [ $CLUSTER_WORKER_UP -eq 1 ]; then
      print_fail "Only Cluster Worker is running on the host; Host Worker is missing" "Run 'npm run dev' or 'npm run dev:worker' to start the host worker."
      FAILED=1
    else
      print_fail "No active workers detected (neither in-cluster pod nor host processes)" "Run 'npm run dev' to start the backend and worker processes on the host."
      FAILED=1
    fi
  fi
fi

# 6. GPU Diagnostics (optional, informational)
echo ""
echo "🔍 GPU Diagnostics:"
if command -v nvidia-smi &>/dev/null; then
  NVIDIA_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l)
  if [ "$NVIDIA_COUNT" -gt 0 ]; then
    NVIDIA_NAMES=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    print_ok "NVIDIA GPU detected: ${NVIDIA_NAMES} (${NVIDIA_COUNT} GPU(s))"

    # Check Docker NVIDIA runtime
    if docker info 2>/dev/null | grep -qi "nvidia"; then
      print_ok "NVIDIA Container Toolkit configured for Docker"
    else
      print_fail "NVIDIA Container Toolkit NOT configured for Docker" "Install nvidia-container-toolkit and run: sudo nvidia-ctk runtime configure --runtime=docker, then restart Docker"
    fi

    # Check in-cluster device plugin (if cluster is up)
    if [ $FAILED -eq 0 ]; then
      DS_EXISTS=$("$KUBECTL" get daemonset nvidia-device-plugin-daemonset -n kube-system --context "${CONTEXT}" -o name 2>/dev/null || echo "")
      if [ -n "$DS_EXISTS" ]; then
        DS_READY=$("$KUBECTL" get daemonset nvidia-device-plugin-daemonset -n kube-system --context "${CONTEXT}" -o jsonpath='{.status.numberReady}' 2>/dev/null || echo "0")
        if [ "${DS_READY:-0}" -gt 0 ]; then
          print_ok "NVIDIA device plugin DaemonSet is running (${DS_READY} pod(s) ready)"
        else
          print_fail "NVIDIA device plugin DaemonSet has no ready pods" "Check: kubectl get pods -n kube-system -l name=nvidia-device-plugin-ds"
        fi
      else
        echo -e "  ℹ️   NVIDIA device plugin not installed (auto-installed on first vLLM deploy)"
      fi
    fi
  fi
elif command -v rocminfo &>/dev/null; then
  print_ok "AMD ROCm toolkit detected"

  # Check Docker ROCm runtime
  if docker info 2>/dev/null | grep -qiE "rocm|hip"; then
    print_ok "ROCm Container Toolkit configured for Docker"
  else
    print_fail "ROCm Container Toolkit NOT configured for Docker" "Install ROCm container runtime and configure Docker"
  fi

  # Check in-cluster device plugin (if cluster is up)
  if [ $FAILED -eq 0 ]; then
    DS_EXISTS=$("$KUBECTL" get daemonset amdgpu-device-plugin-daemonset -n kube-system --context "${CONTEXT}" -o name 2>/dev/null || echo "")
    if [ -n "$DS_EXISTS" ]; then
      DS_READY=$("$KUBECTL" get daemonset amdgpu-device-plugin-daemonset -n kube-system --context "${CONTEXT}" -o jsonpath='{.status.numberReady}' 2>/dev/null || echo "0")
      if [ "${DS_READY:-0}" -gt 0 ]; then
        print_ok "AMD device plugin DaemonSet is running (${DS_READY} pod(s) ready)"
      else
        print_fail "AMD device plugin DaemonSet has no ready pods" "Check: kubectl get pods -n kube-system -l name=amdgpu-dp-ds"
      fi
    else
      echo -e "  ℹ️   AMD device plugin not installed (auto-installed on first vLLM deploy)"
    fi
  fi
else
  echo -e "  ℹ️   No GPU toolkit detected (NVIDIA or AMD). GPU workloads (vLLM) will not work."
fi

# Final Summary
if [ $FAILED -eq 0 ]; then
  echo -e "\n🟢  \033[32mEnvironment is healthy and ready!\033[0m"
  exit 0
else
  echo -e "\n🔴  \033[31mEnvironment diagnostics failed. Please resolve the issues highlighted above.\033[0m"
  exit 1
fi
