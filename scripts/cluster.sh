#!/usr/bin/env bash
# cluster.sh — Wraps the k3d cluster lifecycle with a `k3d cluster wait` call.
#
# The worker entry point will also do this automatically if no cluster is up.
#
# Usage:
#   cluster.sh create [--Worker] [--service] [--run]
#   cluster.sh delete [--subject: name]
#   cluster.sh status   (return current cluster name)
#   cluster.sh use [--subject: name] [--cluster-name]: use k3d context
#
# Plan:
#   1. `k3d cluster create --agents 1 --wait 1 <name>` → waits for cluster creation (but API server isn't guaranteed to be ready).
#   2. Loop until `kubectl get nodes` shows at least one `Ready` node (or `k3d cluster get <name>/api-health` returns OK).
#   3. Timeout at 5-10 minutes to avoid hanging indefinitely.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROVISIONER_CLUSTER="${PROVISIONER_CLUSTER:-provisioning-lunorica}"

K3D="${ROOT}/bin/k3d"
if [ ! -f "$K3D" ] || ! "$K3D" --version >/dev/null 2>&1; then
  K3D="k3d"
fi

KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi

# ── Native k3s (Linux-only management cluster; GPU-capable, no Docker-in-Docker nesting) ──
#
# macOS has no native k3s (no Linux kernel) and no supported CUDA/ROCm driver stack at all,
# so the management cluster stays k3d there — see run_cluster_create()'s OS branch below.

is_linux() { [ "$(uname -s)" = "Linux" ]; }

k3s_native_name() { echo "${1:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"; }
k3s_native_unit()          { echo "k3s-$(k3s_native_name "$1").service"; }
k3s_native_data_dir()      { echo "/var/lib/rancher/k3s-$(k3s_native_name "$1")"; }
k3s_native_kubeconfig()    { echo "$(k3s_native_data_dir "$1")/kubeconfig.yaml"; }

# Installed = the systemd unit file exists. Does NOT imply it's running.
native_k3s_installed() {
  local unit; unit="$(k3s_native_unit "$1")"
  [ -f "/etc/systemd/system/${unit}" ]
}

# Installs (but does not start/enable) k3s as a named systemd service. Requires sudo —
# intended to be called explicitly from setup.sh, never silently from the dev-time flow.
native_k3s_install() {
  local name; name="$(k3s_native_name "$1")"
  local data_dir; data_dir="$(k3s_native_data_dir "$name")"
  local kubeconfig; kubeconfig="$(k3s_native_kubeconfig "$name")"

  if native_k3s_installed "$name"; then
    echo "  ▶  native k3s (${name}) already installed — skipping"
    return 0
  fi

  echo "  ▶  installing native k3s as systemd service (name=${name})..."
  if curl -sfL https://get.k3s.io | \
      INSTALL_K3S_NAME="${name}" \
      INSTALL_K3S_SKIP_ENABLE=true \
      INSTALL_K3S_SKIP_START=true \
      sh -s - server \
        --data-dir "${data_dir}" \
        --write-kubeconfig "${kubeconfig}" \
        --write-kubeconfig-mode 644 \
        --disable=traefik,servicelb; then
    echo "  ✅ native k3s installed (inactive — started on demand)"
  else
    echo "  ❌ native k3s install failed — exiting"
    return 1
  fi
}

native_k3s_is_active() {
  local unit; unit="$(k3s_native_unit "$1")"
  systemctl is-active --quiet "$unit" 2>/dev/null
}

# Clean-only: stops the service, kills anything it left behind, and wipes its data-dir (certs,
# etcd/kine state, generated containerd config — everything that makes this specific instance).
# Deliberately does NOT reinstall, reconfigure, or restart anything — that's setup's job
# (setup-gpu.sh regenerates the containerd GPU config, setup.sh/`cluster.sh create` brings it
# back up). Keeping this reset step pure "removal" mirrors the k3d cleanup path above it, which
# also only deletes. No-op if not installed. Requires sudo (interactive).
native_k3s_reset() {
  local name; name="$(k3s_native_name "$1")"
  local unit; unit="$(k3s_native_unit "$name")"
  local data_dir; data_dir="$(k3s_native_data_dir "$name")"

  if ! native_k3s_installed "$name"; then
    echo "  ▶  native k3s (${name}) not installed — nothing to reset"
    return 0
  fi

  echo "  ▶  stopping native k3s (${name})..."
  sudo systemctl stop "$unit" 2>/dev/null || true

  # A plain stop doesn't always reap every child process cleanly — containerd-shims in
  # particular can survive an abrupt or crashed containerd and linger outside the unit's
  # cgroup. Left behind, they cause systemd to warn about "unclean termination of a previous
  # run" on the next start and can leave stale container state around even after the data-dir
  # wipe below. Kill anything still referencing this instance so the next start is genuinely
  # starting from nothing — this is exactly the class of "transient issue" a clean should
  # remove, not just the data-dir.
  #
  # Deliberately NOT `pkill -f <pattern>`: run as `sudo pkill -9 -f "$data_dir"`, the pattern
  # text is itself an argument on the invoking `sudo pkill ...` command line, so `-f` matches
  # (and kills) that very invocation — self-inflicted SIGKILL, surfaced as bash's own noisy
  # "Killed" job-control message. Splitting discovery (pgrep, no sudo, no pattern text baked
  # into what's being matched) from the actual kill (plain PIDs, no pattern matching at all)
  # sidesteps this entirely.
  echo "  ▶  cleaning up any leftover k3s/containerd processes..."
  local leftover_pids
  leftover_pids="$(pgrep -f "${data_dir}|/run/k3s/containerd/containerd.sock" 2>/dev/null || true)"
  if [ -n "$leftover_pids" ]; then
    echo "$leftover_pids" | xargs -r sudo kill -9 2>/dev/null || true
  fi
  sleep 1

  if [ -d "$data_dir" ]; then
    echo "  ▶  wiping native k3s data-dir (${data_dir})..."
    sudo rm -rf "$data_dir"
  fi

  # flannel's VXLAN interface and the CNI bridge can also survive a reset with stale IP/route
  # state from the wiped cluster (fresh etcd means a fresh pod CIDR allocation next start) —
  # safe to remove, flannel/kubelet recreate them cleanly on the next start.
  echo "  ▶  removing stale flannel/CNI network interfaces..."
  sudo ip link delete flannel.1 2>/dev/null || true
  sudo ip link delete cni0 2>/dev/null || true

  echo "  ✅ native k3s (${name}) reset — re-run setup to bring it back up"
}

# Starts the service (sudo, interactive) and merges its kubeconfig into the default
# kubeconfig under context "k3d-<name>" — matching k3d's own naming convention exactly,
# so every existing `--context k3d-<name>` call site (backend and shell scripts alike)
# keeps working unmodified regardless of which runtime actually backs the cluster.
native_k3s_ensure_running() {
  local name; name="$(k3s_native_name "$1")"
  local unit; unit="$(k3s_native_unit "$name")"
  local kubeconfig; kubeconfig="$(k3s_native_kubeconfig "$name")"

  if ! native_k3s_installed "$name"; then
    echo "  ❌ native k3s (${name}) is not installed. Run: sudo bash scripts/setup.sh"
    return 1
  fi

  if ! native_k3s_is_active "$name"; then
    echo "  ▶  starting native k3s (${name}) — sudo required (once per boot)..."
    sudo systemctl start "$unit"
  fi

  # Wait for the kubeconfig to appear and the API server to accept requests.
  local deadline; deadline="$(($(date +%s) + 60))"
  while [ ! -s "$kubeconfig" ] && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 1
  done
  if [ ! -s "$kubeconfig" ]; then
    echo "  ❌ native k3s (${name}) did not write a kubeconfig in time"
    return 1
  fi

  echo "  ▶  waiting for API server + node to be ready..."
  local node_deadline; node_deadline="$(($(date +%s) + 120))"
  local node_ready=0
  while [ "$(date +%s)" -lt "$node_deadline" ]; do
    if KUBECONFIG="$kubeconfig" "$KUBECTL" get nodes 2>/dev/null | grep -q "Ready"; then
      node_ready=1
      break
    fi
    sleep 2
  done
  if [ "$node_ready" -ne 1 ]; then
    echo "  ❌ native k3s (${name}) node didn't become Ready in time"
    return 1
  fi

  # Merge into the default kubeconfig, renamed to match k3d's context convention.
  local tmp; tmp="$(mktemp)"
  sed -e "s/name: default/name: k3d-${name}/" \
      -e "s/cluster: default/cluster: k3d-${name}/" \
      -e "s/user: default/user: k3d-${name}/" \
      -e "s/current-context: default/current-context: k3d-${name}/" \
      "$kubeconfig" > "$tmp"
  # NOTE: kubectl's flatten-merge resolves name conflicts first-file-wins, so the new
  # (renamed) kubeconfig MUST come before the existing default — otherwise a stale entry
  # from a previous k3d "provisioning-lunorica" cluster silently wins and this rename is a
  # no-op (confirmed empirically: reversing this order is what actually fixes it).
  KUBECONFIG="${tmp}:${HOME}/.kube/config" "$KUBECTL" config view --flatten > "${HOME}/.kube/config.merged"
  mkdir -p "${HOME}/.kube"
  mv "${HOME}/.kube/config.merged" "${HOME}/.kube/config"
  rm -f "$tmp"

  echo "  ✅ native k3s (${name}) up — context k3d-${name}"
}

run_cluster_create() {
  if is_linux; then
    local name; name="$(k3s_native_name "${1:-}")"
    native_k3s_ensure_running "$name"
    return $?
  fi

  # macOS (and any other non-Linux host): k3d, unchanged.
  # Install k3d if missing
  if ! command -v "$K3D" >/dev/null 2>&1; then
    local OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    local ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64)       ARCH="amd64" ;;
      arm64|aarch64) ARCH="arm64" ;;
    esac
    if curl -fsSL "https://github.com/k3d-io/k3d/releases/latest/download/k3d-${OS}-${ARCH}" \
       -o /tmp/k3d-bin \
       && install -m 0755 /tmp/k3d-bin ~/.local/bin/k3d \
       && export PATH="$HOME/.local/bin:$PATH" \
       && echo 'export PATH="$HOME/.local/bin:$PATH" # k3d' >> ~/.bashrc 2>/dev/null || true; then
      K3D="k3d"
      "$K3D" version >/dev/null 2>&1 || true
      echo "  ✅ installed k3d"
    else
      rm -f /tmp/k3d-bin
      echo "  ❌ k3d install failed — exiting"
      return 1
    fi
  fi

  echo "  ▶  provisioning k3d ${1:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"
  if "$K3D" cluster create "${1:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}" \
      --agents 1 \
      -v /var/run/docker.sock:/var/run/docker.sock@all \
      >/dev/null 2>&1; then
    echo "  ✅ k3d up"
  else
    echo "  ❌ cluster failed — exiting"
  fi
}

run_cluster_delete() {
  local cluster_name="${1:-}"
  [[ -z "${cluster_name}" ]] && return 0
  if "$K3D" cluster list 2>/dev/null | grep -q "$cluster_name"; then
    "$K3D" cluster delete "$cluster_name" > /dev/null 2>&1 || true
  fi
}

run_cluster_delete_all() {
  local cluster_names
  cluster_names="$("$K3D" cluster list 2>/dev/null | awk '{print $1}' || true)"
  for cluster in $cluster_names; do
    run_cluster_delete "$cluster"
  done
}

run_cluster_status() {
  local context
  context="$("$K3D" cluster get "$PROVISIONER_CLUSTER" 2>/dev/null || true)"
  echo "Cluster ${PROVISIONER_CLUSTER} context: ${context:-[LOCAL]}"
  # Log and stdout to both
  tee /tmp/cluster-big-file 2>&1
}

# ── `k3d cluster wait` (checks if the cluster is alive — API server + nodes ready) ──

cluster_wait_for_ready() {
  # Returns 0/1; the caller decides whether to log or fail
  local cluster_name="${1:?CLUSTER}"
  while true; do
    if "$K3D" cluster list 2>/dev/null | grep -q "$cluster_name"; then
      return 0
    fi
    sleep 1
  done
}

cluster_until_ready() {
  # Waits for the cluster to be actually alive:
  #   1. `k3d cluster list` shows the cluster.
  #   2. `kubectl get nodes` shows at least one `Ready` node (or `k3d cluster get <name>/api-health` returns OK).
  #   3. Timeout at 10 minutes — avoid hanging indefinitely.
  local cluster_name="$1"
  local deadline
  deadline="$(date +%s) + 600" # 10-minute timeout

  cluster_wait_for_ready "$cluster_name"

  echo "  ▶  cluster up — waiting for API server + nodes to be ready..."
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    # Check 1: kubectl get nodes
    if "$KUBECTL" get nodes 2>/dev/null | grep -q "Ready"; then
      echo "  ✅ API server ready"
      return 0
    fi
    # Check 2: k3d cluster get <name>/api-health
    if "$K3D" cluster get "$cluster_name/api-health" 2>/dev/null | grep -q "OK"; then
      echo "  ✅ API server ready (via k3d)"
      return 0
    fi
    sleep 1
  done
  echo "  ❌ cluster didn't become ready in time — exiting"
  return 1
}

cluster_wait() {
  # If the cluster is not ready, wait up to 60 seconds
  local cluster_name="$1"
  cluster_wait_for_ready "$cluster_name"
  echo "  k3d ${cluster_name} ready"
}

# ── Self-reference ──

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: cluster.sh [command] [args]"
  echo "  create                  → Linux: start native k3s management cluster (GPU-capable)"
  echo "                            macOS: k3d cluster create --agents 1 --wait 1 <cluster-name>"
  echo "  install                 → Linux only: install (but do not start) native k3s systemd service"
  echo "  reset                   → Linux only: stop native k3s and wipe its state (no reinstall)"
  echo "  delete [cluster-name]   → k3d cluster delete <cluster-name>"
  echo "  delete-all              → k3d cluster delete ALL clusters"
  echo "  status                  → list all running cluster procs"
  echo "                            (k3d cluster wait --before=false)"
  echo ""
  echo "Diags:"
  echo "  workdir                 → the worker's workdir path"
  echo "  provisioner_state"
  echo "  use                     → list running clusters"
  echo ""
  exit 0
fi

case "${1:-}" in
  create)
    # Cluster creation (sets env for WorkerService)
    run_cluster_create "${2:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"
    # run_cluster_create already blocks until ready on Linux (native k3s); on macOS (k3d)
    # readiness is a separate wait step against `k3d cluster list`.
    if ! is_linux; then
      cluster_until_ready "${2:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"
    fi
    ;;
  install)
    # Install-only (Linux native k3s) — never starts the service. No-op on macOS (k3d has
    # nothing analogous to "install" beyond the binary download setup.sh already does).
    if is_linux; then
      native_k3s_install "${2:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"
    fi
    ;;
  reset)
    # Clean-only (Linux native k3s) — stop + wipe state, no reinstall/reconfigure/restart.
    # macOS: no-op here, its management cluster is k3d and already covered by `delete`.
    if is_linux; then
      native_k3s_reset "${2:-${PROVISIONER_CLUSTER:-provisioning-lunorica}}"
    fi
    ;;
  delete)
    cluster_name="${2:-}"
    run_cluster_delete "$cluster_name"
    ;;
  delete-all)
    run_cluster_delete_all
    ;;
  status)
    run_cluster_status
    ;;
  use)
    # List running clusters
    cluster_name="${3:-}"
    context="$("$K3D" cluster get "$cluster_name" 2>/dev/null || true)"
    echo "Cluster: ${cluster_name} context: ${context:-[LOCAL]}"
    ;;
  workdir|provisioner_state|kubeconfig)
    echo "bosh"
    ;;
esac
