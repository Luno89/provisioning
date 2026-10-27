import dns from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { addressProblem } from '../lib/public-address.js';

export class NotPublicError extends Error {
  constructor(why: string) {
    super(`Koala does not reach that from here: ${why}`);
    this.name = 'NotPublicError';
  }
}

const REDIRECTS = 10;

const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const refused = addresses.map((entry) => addressProblem(entry.address)).find(Boolean);
    if (refused || addresses.length === 0) return callback(new NotPublicError(`${hostname} resolves to ${refused ?? 'nothing'}`), '', 0);
    if (options.all) return (callback as unknown as (err: null, all: dns.LookupAddress[]) => void)(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

const PUBLIC_ONLY = new Agent({ connect: { lookup: publicLookup }, headersTimeout: 0, bodyTimeout: 0 });

const literalProblem = (url: URL): string | undefined => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol} is not http or https`;
  if (url.username || url.password) return 'an address carrying a name and password';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return isIP(host) ? addressProblem(host) : undefined;
};

export async function publicAddressProblem(raw: string): Promise<string | undefined> {
  let url: URL;
  try { url = new URL(raw); } catch { return `${raw} is not an address`; }
  const literal = literalProblem(url);
  if (literal) return literal;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return undefined;
  const addresses = await dns.promises.lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) return `${host} resolves to nothing`;
  return addresses.map((entry) => addressProblem(entry.address)).find(Boolean);
}

export const publicFetch: typeof fetch = async (input, init) => {
  let url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  for (let hop = 0; ; hop += 1) {
    const problem = literalProblem(url);
    if (problem) throw new NotPublicError(problem);
    const response = await globalThis.fetch(url, { ...init, redirect: 'manual', dispatcher: PUBLIC_ONLY } as unknown as RequestInit).catch((err: unknown) => {
      const cause = (err as { cause?: unknown }).cause;
      throw cause instanceof NotPublicError ? cause : err;
    });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return response;
    if (hop >= REDIRECTS) throw new NotPublicError(`${url.host} redirected more than ${REDIRECTS} times`);
    await response.body?.cancel().catch(() => undefined);
    url = new URL(location, url);
  }
};
