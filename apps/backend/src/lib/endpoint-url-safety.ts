/**
 * Guards user-registered model endpoint URLs against being used as a server-side request forgery
 * primitive.
 *
 * This matters more here than on a typical app. The backend runs on the root node, which also runs
 * Headscale (its admin API on localhost:8080), Mongo, Temporal and the Gitea registry — all
 * unauthenticated on loopback because nothing outside the box was ever supposed to reach them. A
 * registered endpoint whose URL is `http://localhost:8080/api/v1/...` turns "chat with my model"
 * into "make the platform call its own control plane on my behalf".
 *
 * Cloud metadata is the other classic: 169.254.169.254 hands out instance credentials to anything
 * that asks from the host.
 *
 * The mesh complicates this, because 100.64.0.0/10 is EXACTLY where legitimate bring-your-own
 * endpoints live. So the CGNAT range cannot simply be blocked — it is allowed, and ownership is
 * enforced separately by checking the address belongs to one of the caller's own Headscale devices
 * (see ModelService). That second check is not optional: the root node carries `tag:platform` in
 * acl.hujson and can therefore reach EVERY tenant's machines, so without it one user could
 * register another user's Ollama address and talk to it.
 */

/** Parsed IPv4 as a 32-bit number, or undefined if the string is not a dotted quad. */
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

/** The Headscale mesh range — the whole point of the feature, so allowed rather than blocked. */
export const MESH_CIDR = '100.64.0.0/10';

const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '127.0.0.0/8', // the root node's own control plane
  '169.254.0.0/16', // cloud instance metadata
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

/**
 * Whether a literal IP is acceptable as an endpoint host.
 *
 * Mesh addresses are allowed; every other private, loopback, link-local or reserved range is not.
 * IPv6 is refused wholesale rather than half-checked — the equivalent range analysis (::1, fc00::/7,
 * link-local, and v4-mapped forms like ::ffff:127.0.0.1 that smuggle loopback past a naive check)
 * is easy to get subtly wrong, and no mesh or model endpoint needs it today.
 */
export function isAllowedIp(host: string): boolean {
  if (host.includes(':')) return false; // IPv6 — see above
  const ip = ipv4ToInt(host);
  if (ip === undefined) return false;
  if (inRange(ip, MESH_CIDR)) return true;
  return !BLOCKED_V4.some((cidr) => inRange(ip, cidr));
}

export interface UrlCheck {
  ok: boolean;
  /** Why it was refused — safe to show the user; never contains anything they did not supply. */
  reason?: string;
  /** Literal IPv4 host, when the URL used one rather than a name. */
  literalIp?: string;
  hostname?: string;
}

/**
 * Structural check of a user-supplied endpoint URL.
 *
 * Deliberately does NOT resolve DNS. A hostname that resolves to 127.0.0.1 today can resolve
 * somewhere else on the next lookup (DNS rebinding), so a resolve-then-fetch check gives false
 * confidence. Hostnames are therefore accepted structurally here and must be pinned at request
 * time by the caller — see ModelService, which only accepts literal mesh IPs for mesh endpoints
 * and requires https for named hosts.
 */
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

  // URL keeps IPv6 literals in brackets; strip so the v6 rejection below is reached.
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

  // A bare name with no dot ("localhost", "mongo", a Docker service alias) resolves to something
  // internal far more often than to anything a tenant legitimately owns.
  if (!hostname.includes('.')) {
    return { ok: false, reason: `"${hostname}" is not a public hostname. Use a mesh IP or a fully-qualified domain.` };
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    return { ok: false, reason: `"${hostname}" resolves inside the platform's own network` };
  }

  return { ok: true, hostname };
}
