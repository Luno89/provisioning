#!/bin/sh
set -eu

RELEASE="20261005.0"
SHA512="27fed731b432d6a39d908956623fd273979fda66b3ccf4b9c12413ea417c516e18a9dc3cced403fb28efe495d64dce4251f51cf8c4d9f4a72f9833bd96b6bb35"
TARBALL=""
YES=0
CONTAINERD_DIR=/var/lib/rancher/k3s/agent/etc/containerd

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --tarball) TARBALL="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
ask() {
  [ "$YES" = 1 ] && return 0
  printf '  %s [y/N] ' "$1"
  read -r answer < /dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
kube() { if command -v kubectl >/dev/null 2>&1; then kubectl "$@"; else k3s kubectl "$@"; fi; }

[ "$(id -u)" = 0 ] || die "run this as root"
[ "$(uname -m)" = x86_64 ] || die "the pinned gVisor build is for x86_64"
[ -d "$CONTAINERD_DIR" ] || die "no k3s containerd here ($CONTAINERD_DIR)"
UNIT=$(systemctl list-units --type=service --all --no-legend 'k3s*' | awk '{print $1}' | grep -E '^k3s(-.+)?\.service$' | grep -v agent | head -1)
[ -n "$UNIT" ] || die "no k3s service found"

say "gVisor $RELEASE"
if [ -x /usr/local/bin/runsc ] && /usr/local/bin/runsc --version 2>/dev/null | grep -q "release-$RELEASE"; then
  ok "runsc $RELEASE is installed"
else
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  if [ -z "$TARBALL" ]; then
    TARBALL="$work/gvisor.tar.zstd"
    curl -fsSL -o "$TARBALL" "https://storage.googleapis.com/gvisor/releases/release/$RELEASE/x86_64/gvisor.tar.zstd"
  fi
  echo "$SHA512  $TARBALL" | sha512sum -c --quiet - || die "the gVisor download does not match its pinned checksum"
  tar --zstd -xf "$TARBALL" -C "$work" runsc containerd-shim-runsc-v1 gvisor-bin || die "could not unpack gVisor (zstd is needed)"
  rm -rf /usr/local/bin/gvisor-bin
  cp -a "$work/gvisor-bin" /usr/local/bin/gvisor-bin
  install -m 0755 "$work/runsc" "$work/containerd-shim-runsc-v1" /usr/local/bin/
  ok "runsc, its containerd shim and its helpers installed in /usr/local/bin"
fi

TEMPLATE="$CONTAINERD_DIR/config-v3.toml.tmpl"
if [ -f "$TEMPLATE" ] && grep -q "runtimes.runsc" "$TEMPLATE"; then
  ok "k3s's containerd already offers runsc"
else
  if [ -f "$TEMPLATE" ] && ! grep -q '{{ template "base" . }}' "$TEMPLATE"; then
    die "$TEMPLATE is someone's own containerd template; add the runsc runtime to it by hand"
  fi
  ask "k3s ($UNIT) restarts to offer gVisor; pods keep running but the node is briefly unready. Go ahead?" || die "nothing changed"
  mkdir -p /etc/containerd
  printf '[runsc_config]\n  systemd-cgroup = "true"\n' > /etc/containerd/runsc.toml
  [ -f "$TEMPLATE" ] || printf '{{ template "base" . }}\n' > "$TEMPLATE"
  cat >> "$TEMPLATE" <<'EOF'

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc.options]
  TypeUrl = "io.containerd.runsc.v1.options"
  ConfigPath = "/etc/containerd/runsc.toml"
EOF
  systemctl restart "$UNIT"
  ok "k3s restarted with runsc"
fi

say "Kubernetes"
i=0
until kube get --raw /readyz >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 120 ] && die "the API server did not come back after the restart"
  sleep 2
done
kube apply -f - >/dev/null <<'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
EOF
ok "RuntimeClass gvisor"

probe=gvisor-probe-$$
kube run "$probe" --restart=Never --image=busybox:1.37 --overrides='{"spec":{"runtimeClassName":"gvisor"}}' --command -- dmesg >/dev/null
i=0
until [ "$(kube get pod "$probe" -o jsonpath='{.status.phase}' 2>/dev/null)" = Succeeded ]; do
  phase=$(kube get pod "$probe" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  [ "$phase" = Failed ] && { kube describe pod "$probe" | tail -15; kube delete pod "$probe" --wait=false >/dev/null; die "a pod could not run under gVisor"; }
  if kube get events --field-selector "involvedObject.name=$probe,reason=FailedCreatePodSandBox" -o name 2>/dev/null | grep -q .; then
    kube get events --field-selector "involvedObject.name=$probe,reason=FailedCreatePodSandBox" -o jsonpath='{.items[0].message}'; echo
    kube delete pod "$probe" --wait=false >/dev/null; die "gVisor could not start the pod's sandbox"
  fi
  i=$((i + 1)); [ "$i" -gt 150 ] && { kube describe pod "$probe" | tail -15; kube delete pod "$probe" --wait=false >/dev/null; die "a pod under gVisor never finished"; }
  sleep 2
done
seen=$(kube logs "$probe")
kube delete pod "$probe" --wait=false >/dev/null
echo "$seen" | grep -q "gVisor" || die "the probe pod ran, but not under gVisor"
ok "a pod runs under gVisor"
