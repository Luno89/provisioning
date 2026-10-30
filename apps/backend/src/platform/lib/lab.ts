import { addressProblem } from './public-address.js';

type Env = Readonly<Record<string, string | undefined>>;

const LAB_SUFFIXES = ['.internal', '.localhost'];

export const labName = (host: string): boolean => {
  const bare = host.trim().toLowerCase().replace(/\.$/, '');
  return bare === 'localhost' || bare === 'internal' || LAB_SUFFIXES.some((suffix) => bare.endsWith(suffix));
};

const addressLiteral = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

export function staysPrivate(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return addressLiteral(bare) ? addressProblem(bare) !== undefined : labName(bare);
}

export function labFrom(env: Env): boolean {
  const certificates = env.CERTIFICATES?.trim() || (env.ROOT_TLS?.trim() === 'internal' ? 'internal' : '');
  if (certificates !== 'internal') return false;
  return [env.DOMAIN, env.INGRESS_DOMAIN].every((domain) => !domain?.trim() || labName(domain));
}

export function plaintextProblem(name: string, raw: string, env: Env): string | undefined {
  if (env.NODE_ENV !== 'production') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${name} (${raw}) is not an address`;
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol !== 'http:') return `${name} is ${raw}, which is neither https nor http`;
  if (labFrom(env) || staysPrivate(url.hostname)) return undefined;
  return `${name} is ${url.origin}: plain http to an address on the open internet. In production Koala talks to root only over https, so set ${name} to root's https address`;
}
