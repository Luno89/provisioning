const v4 = (address: string): number | undefined => {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
};

const inV4 = (ip: number, cidr: string): boolean => {
  const [base, bits] = cidr.split('/') as [string, string];
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((ip & mask) >>> 0) === ((v4(base)! & mask) >>> 0);
};

const NOT_PUBLIC_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];

export function addressProblem(address: string): string | undefined {
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare)?.[1];
  const ip = v4(mapped ?? bare);
  if (ip !== undefined) {
    return NOT_PUBLIC_V4.some((cidr) => inV4(ip, cidr)) ? `${address} is a private, loopback, mesh or reserved address` : undefined;
  }
  if (!bare.includes(':')) return `${address} is not an address`;
  const first = parseInt(bare.split(':')[0] || '0', 16);
  const second = parseInt(bare.split(':')[1] || '0', 16);
  const tunnelled = first === 0x2002 || (first === 0x2001 && second === 0);
  return (first & 0xe000) === 0x2000 && !tunnelled ? undefined : `${address} is not a public address`;
}
