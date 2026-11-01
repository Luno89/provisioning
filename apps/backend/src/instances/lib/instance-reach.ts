export interface CaddyAddress { host: string; port: number }

export interface ReachSettings {
  open: boolean;
  domain?: string | undefined;
  ownCaddy?: CaddyAddress | undefined;
}

export interface ReachedInstance {
  name?: string | undefined;
  meshIp?: string | undefined;
}

export type Reach = 'open' | 'mesh' | 'assigned' | 'public';

export function caddyAddressOf(text: string): CaddyAddress | undefined {
  const found = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(text.trim());
  return found ? { host: found[1]!, port: Number(found[2]) } : undefined;
}

export function reachSettingsFrom(env: Readonly<Record<string, string | undefined>>, lab: boolean): ReachSettings {
  const domain = env.INGRESS_DOMAIN?.trim() || undefined;
  const ownCaddy = domain ? caddyAddressOf(env.CADDY_TLS_ADDRESS || '127.0.0.1:443') : undefined;
  return { open: env.NODE_ENV !== 'production' || lab, domain, ...(ownCaddy ? { ownCaddy } : {}) };
}

export interface ThroughCaddy extends CaddyAddress { servername: string }

export function throughOwnCaddy(url: URL, settings: ReachSettings): ThroughCaddy | undefined {
  if (url.protocol !== 'https:' || !settings.domain || !settings.ownCaddy) return undefined;
  const host = url.hostname.toLowerCase();
  const domain = settings.domain.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`) ? { ...settings.ownCaddy, servername: host } : undefined;
}

export function instanceOrigin(raw: unknown): { origin: URL } | { problem: string } {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return { problem: 'url is the origin the instance answers on' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: 'url is the origin the instance answers on, over http or https' };
  if (url.username || url.password) return { problem: 'url is the origin the instance answers on, with no name or password in it' };
  return { origin: new URL(url.origin) };
}

const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

export function reachOf(url: URL, instance: ReachedInstance, settings: ReachSettings): Reach {
  if (settings.open) return 'open';
  const host = hostOf(url);
  if (instance.meshIp && host === instance.meshIp) return 'mesh';
  if (url.protocol === 'https:' && instance.name && settings.domain) {
    const domain = settings.domain.toLowerCase();
    if (host === `${instance.name}.${domain}`) return 'assigned';
  }
  return 'public';
}

export const notReachable = (origin: string, why: string): string =>
  `root does not call ${origin}: ${why}. An instance answers on the address root gave it (https://<name>.<people's domain>), its own mesh address, or a public address`;
