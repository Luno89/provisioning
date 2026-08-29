
function ipv4ToInt(host: string): number | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

const inRange = (ip: number, cidr: string): boolean => {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const baseInt = ipv4ToInt(base ?? '');
  if (baseInt === undefined) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (baseInt & mask) >>> 0;
};

export const MESH_CIDR = '100.64.0.0/10';

const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '127.0.0.0/8', // the root node's own control plane
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '192.0.0.0/24',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

export function isMeshAddress(host: string): boolean {
  const ip = ipv4ToInt(host);
  return ip !== undefined && inRange(ip, MESH_CIDR);
}

export function isAllowedIp(host: string): boolean {
  if (host.includes(':')) return false;
  const ip = ipv4ToInt(host);
  if (ip === undefined) return false;
  if (inRange(ip, MESH_CIDR)) return true;
  return !BLOCKED_V4.some((cidr) => inRange(ip, cidr));
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  literalIp?: string;
  hostname?: string;
}

const OPERATION_SUFFIX = /\/(?:chat\/)?completions\/?$/;

export function normaliseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.pathname = url.pathname.replace(OPERATION_SUFFIX, '');
  return url.toString().replace(/\/$/, '');
}

export function checkEndpointUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Not a valid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported scheme "${url.protocol.replace(':', '')}" — use http or https` };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'Credentials in the URL are not supported — use the API key field' };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return { ok: false, reason: 'URL has no host' };

  const isLiteral = ipv4ToInt(hostname) !== undefined || hostname.includes(':');
  if (isLiteral) {
    if (!isAllowedIp(hostname)) {
      return {
        ok: false,
        reason: `${hostname} is a private, loopback or reserved address. Only mesh addresses (${MESH_CIDR}) and public addresses are allowed.`,
      };
    }
    return { ok: true, literalIp: hostname, hostname };
  }

  if (!hostname.includes('.')) {
    return { ok: false, reason: `"${hostname}" is not a public hostname. Use a mesh IP or a fully-qualified domain.` };
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    return { ok: false, reason: `"${hostname}" resolves inside the platform's own network` };
  }

  return { ok: true, hostname };
}
