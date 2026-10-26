#!/usr/bin/env bash
set -euo pipefail

FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1
LAB="${LAB:-0}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
die()  { echo -e "  ${RED}❌${NC} $1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root — this writes kernel, apt, journald, Docker and SSH settings."

write_if_changed() {
  local path="$1" wanted
  wanted="$(cat)"
  [ -f "$path" ] && [ "$(cat "$path")" = "$wanted" ] && return 1
  install -d -m 755 "$(dirname "$path")"
  printf '%s\n' "$wanted" > "$path"
  return 0
}

write_if_changed /etc/sysctl.d/90-koala.conf <<'CONF' || true
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.tcp_syncookies = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.yama.ptrace_scope = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
fs.suid_dumpable = 0
CONF
sysctl --system >/dev/null
ok "kernel: no redirects or source routing, loose reverse-path checks, kernel pointers and dmesg hidden, ptrace limited"

for pkg in unattended-upgrades needrestart; do
  dpkg -s "$pkg" &>/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg" >/dev/null
done
REBOOT=true
[ "$LAB" -eq 1 ] && REBOOT=false
write_if_changed /etc/apt/apt.conf.d/20auto-upgrades <<'CONF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
write_if_changed /etc/apt/apt.conf.d/52koala-unattended <<CONF || true
Unattended-Upgrade::Automatic-Reboot "${REBOOT}";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
write_if_changed /etc/needrestart/conf.d/90-koala.conf <<'CONF' || true
$nrconf{restart} = 'a';
$nrconf{override_rc}{qr(^(docker|containerd|k3s.*|nowrinkles|tailscaled)\.service$)} = 0;
CONF
if [ "$REBOOT" = true ]; then
  ok "security updates install daily; a restart they need happens at 04:30, and services on old libraries restart themselves (Docker, k3s, Tailscale and Koala wait for that)"
else
  ok "security updates install daily; a lab never restarts itself for one"
fi

write_if_changed /etc/systemd/journald.conf.d/90-koala.conf <<'CONF' && { install -d /var/log/journal; systemctl restart systemd-journald; } || true
[Journal]
Storage=persistent
SystemMaxUse=1G
CONF
ok "the journal is kept on disk, at most 1 GB"

DAEMON=/etc/docker/daemon.json
install -d -m 755 /etc/docker
MERGED="$(node -e '
  const fs = require("fs");
  let held = {};
  try { held = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
  const wanted = { "no-new-privileges": true, "live-restore": true, "log-driver": "local", "log-opts": { "max-size": "20m", "max-file": "5" } };
  console.log(JSON.stringify({ ...held, ...wanted }, null, 2));
' "$DAEMON")"
if [ "$(cat "$DAEMON" 2>/dev/null)" != "$MERGED" ]; then
  printf '%s\n' "$MERGED" > "$DAEMON"
  if [ "$FRESH" -eq 1 ]; then
    systemctl restart docker
    ok "Docker: no container gains privileges, logs rotate at 5 × 20 MB, containers outlive a Docker restart"
  else
    warn "Docker's new settings (no-new-privileges, log rotation, live-restore) take effect at its next restart; the next reboot does it"
  fi
else
  ok "Docker: no container gains privileges, logs rotate at 5 × 20 MB, containers outlive a Docker restart"
fi

if [ -d /etc/cloud ] && [ ! -f /etc/cloud/cloud-init.disabled ]; then
  touch /etc/cloud/cloud-init.disabled
fi
ok "cloud-init does not run again on the next boot"

ADMIN_RECORD=/etc/koala/admin-user
ADMIN="$(cat "$ADMIN_RECORD" 2>/dev/null || true)"
[ -n "$ADMIN" ] || ADMIN="${SUDO_USER:-}"
if [ -z "$ADMIN" ] || [ "$ADMIN" = root ]; then
  ADMIN="${ADMIN_USER:-koala-admin}"
  if ! id "$ADMIN" &>/dev/null; then
    [ -s /root/.ssh/authorized_keys ] || die "root has no SSH key and no admin user signed in with sudo: sign in as a user with your key and sudo, and run this again"
    useradd --create-home --shell /bin/bash --groups sudo "$ADMIN"
    install -d -m 700 -o "$ADMIN" -g "$ADMIN" "/home/${ADMIN}/.ssh"
    install -m 600 -o "$ADMIN" -g "$ADMIN" /root/.ssh/authorized_keys "/home/${ADMIN}/.ssh/authorized_keys"
    echo "${ADMIN} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${ADMIN}"
    chmod 440 "/etc/sudoers.d/90-${ADMIN}"
    visudo -cf "/etc/sudoers.d/90-${ADMIN}" >/dev/null || die "the sudo rule for ${ADMIN} does not parse"
    warn "made ${ADMIN} with root's SSH keys and sudo; sign in as ${ADMIN} from now on, since root cannot"
  fi
fi
ADMIN_HOME="$(getent passwd "$ADMIN" | cut -d: -f6)"
[ -s "${ADMIN_HOME}/.ssh/authorized_keys" ] || die "${ADMIN} has no SSH key in ${ADMIN_HOME}/.ssh/authorized_keys, so turning passwords off would lock everyone out"
install -d -m 755 /etc/koala
[ -f "$ADMIN_RECORD" ] || echo "$ADMIN" > "$ADMIN_RECORD"
if write_if_changed /etc/ssh/sshd_config.d/90-koala.conf <<CONF; then
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers ${ADMIN}
MaxAuthTries 3
X11Forwarding no
AllowAgentForwarding no
CONF
  sshd -t || { rm -f /etc/ssh/sshd_config.d/90-koala.conf; die "the SSH settings do not parse; nothing was changed"; }
  systemctl reload ssh
fi
ok "SSH: keys only, no root login, only ${ADMIN} (host key $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'); write it down)"
