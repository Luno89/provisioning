export interface LanNic {
  mac: string;
  address: string;
  nameservers?: string[];
}

export interface VmNetwork {
  uplinkMac: string;
  lan: LanNic;
}

export const macFor = (bytes: Uint8Array): string =>
  ['52', '54', '00', ...Array.from(bytes.slice(0, 3), (byte) => byte.toString(16).padStart(2, '0'))].join(':');

export function netplanFor(network: VmNetwork): string {
  const lan = [
    '    lan:',
    '      match:',
    `        macaddress: "${network.lan.mac}"`,
    '      set-name: lan0',
    '      addresses:',
    `        - ${network.lan.address}`,
  ];
  if (network.lan.nameservers?.length) {
    lan.push('      nameservers:', '        addresses:', ...network.lan.nameservers.map((server) => `          - ${server}`));
  }
  return [
    'version: 2',
    'ethernets:',
    '    uplink:',
    '      match:',
    `        macaddress: "${network.uplinkMac}"`,
    '      set-name: uplink0',
    '      dhcp4: true',
    ...(network.lan.nameservers?.length ? ['      dhcp4-overrides:', '        use-dns: false'] : []),
    ...lan,
    '',
  ].join('\n');
}

export type LanSocket = { listen: number } | { connect: number };

export const lanNicArgument = (socket: LanSocket, mac: string): string =>
  `socket,${'listen' in socket ? `listen=127.0.0.1:${socket.listen}` : `connect=127.0.0.1:${socket.connect}`},mac=${mac},model=virtio-net-pci`;
