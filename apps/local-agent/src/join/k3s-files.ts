import { K3S_UNINSTALL } from '../machine-cluster.js';

export const K3S_CONFIG = '/etc/rancher/k3s/config.yaml';
export const K3S_NODE_PORTS_FILE = '/etc/rancher/k3s/config.yaml.d/koala-node-ports.yaml';
export const K3S_REGISTRIES = '/etc/rancher/k3s/registries.yaml';
export const K3S_FIREWALL = '/usr/local/lib/koala/k3s-firewall.sh';
export const K3S_FIREWALL_DROPIN = '/etc/systemd/system/k3s.service.d/koala-firewall.conf';
export const K3S_SUDOERS = '/etc/sudoers.d/koala-k3s';
export const K3S_UNIT = '/etc/systemd/system/k3s.service';
export const NVIDIA_CDI_MARKER = '/etc/koala/nvidia-cdi';

export const K3S_NODE_PORTS = 'kube-proxy-arg+:\n  - nodeport-addresses=127.0.0.1/32,100.64.0.0/10\n';

export const k3sConfig = (meshIp: string, group: string): string =>
  `disable:\n  - traefik\n  - servicelb\ntls-san:\n  - ${meshIp}\nwrite-kubeconfig-mode: "0640"\nwrite-kubeconfig-group: ${group}\n`;

const mirrorEntry = (registry: string): string => `  "${registry}":\n    endpoint:\n      - "http://${registry}"\n`;

export function withMirror(now: string | undefined, registry: string): string | undefined {
  if (!registry) return now;
  if (now?.includes(`"${registry}":`)) return now;
  if (now !== undefined && /^mirrors:.*$/m.test(now)) return now.replace(/^mirrors:.*\n?/m, (line) => `${line.endsWith('\n') ? line : `${line}\n`}${mirrorEntry(registry)}`);
  const before = now === undefined || now === '' ? '' : now.endsWith('\n') ? now : `${now}\n`;
  return `${before}mirrors:\n${mirrorEntry(registry)}`;
}

export const sudoRule = (user: string, systemctl: string): string =>
  `${user} ALL=(root) NOPASSWD: ${systemctl} start k3s, ${systemctl} stop k3s, /usr/local/bin/k3s-killall.sh, ${K3S_UNINSTALL}\n`;

export const K3S_FIREWALL_SCRIPT = `#!/bin/sh
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
`;

export const K3S_FIREWALL_UNIT = `[Service]\nExecStartPre=${K3S_FIREWALL}\n`;

export const MACHINE_UNINSTALL_SCRIPT = `#!/bin/sh
[ -x /usr/local/bin/k3s-uninstall.sh ] && /usr/local/bin/k3s-uninstall.sh
for tables in iptables ip6tables; do
  command -v "$tables" >/dev/null 2>&1 || continue
  while "$tables" -D INPUT -p tcp -m multiport --dports 6443,10250 -j KOALA-MACHINE 2>/dev/null; do :; done
  "$tables" -F KOALA-MACHINE 2>/dev/null && "$tables" -X KOALA-MACHINE 2>/dev/null
done
rm -rf ${K3S_FIREWALL_DROPIN} /etc/koala/machine-k3s ${K3S_FIREWALL} ${K3S_SUDOERS}
if [ -f ${NVIDIA_CDI_MARKER} ]; then
  systemctl disable --now nvidia-cdi-refresh.path
  case "$(cat ${NVIDIA_CDI_MARKER})" in
    apt) apt-get remove -y nvidia-container-toolkit nvidia-container-toolkit-base libnvidia-container-tools libnvidia-container1 && rm -f /etc/apt/sources.list.d/koala-nvidia-container-toolkit.list /usr/share/keyrings/koala-nvidia-container-toolkit.asc ;;
    dnf) dnf remove -y nvidia-container-toolkit nvidia-container-toolkit-base libnvidia-container-tools libnvidia-container1 && rm -f /etc/yum.repos.d/koala-nvidia-container-toolkit.repo /etc/pki/rpm-gpg/KOALA-NVIDIA-CONTAINER-TOOLKIT ;;
  esac
  rm -f ${NVIDIA_CDI_MARKER} /var/run/cdi/nvidia.yaml
fi
systemctl daemon-reload
rm -f ${K3S_UNINSTALL}
`;
