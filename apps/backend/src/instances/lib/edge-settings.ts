import type { Settings } from '../../platform/index.js';

export interface EdgeSettings {
  name: string | undefined;
  localPort: number | undefined;
  sites: string;
  adminUrl: string;
  caddyfile: string;
}

export const EDGE_SETTINGS = ['EDGE_ADMIN_URL', 'EDGE_CADDYFILE', 'EDGE_SITES'] as const;

export const NO_EDGE = 'this instance has no edge (EDGE_ADMIN_URL, EDGE_CADDYFILE and EDGE_SITES are not set), so its apps get no addresses';

export function edgeSettingsFrom(env: Settings): EdgeSettings | { off: string } {
  const missing = EDGE_SETTINGS.filter((key) => !env[key]?.trim());
  if (missing.length === EDGE_SETTINGS.length) return { off: NO_EDGE };
  if (missing.length) throw new Error(`The edge's settings are half given: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set; the instance chart sets them all`);
  const localText = env.EDGE_LOCAL_PORT?.trim();
  const localPort = localText ? Number(localText) : undefined;
  if (localPort !== undefined && !(Number.isInteger(localPort) && localPort > 0 && localPort < 65536)) throw new Error(`EDGE_LOCAL_PORT is not a port: ${localText}`);
  const name = env.INSTANCE_NAME?.trim() || undefined;
  if (env.INGRESS_DOMAIN?.trim() && !name) throw new Error('INGRESS_DOMAIN is set without INSTANCE_NAME, so the instance\'s public addresses have no name to go under');
  return { name, localPort, sites: env.EDGE_SITES!.trim(), adminUrl: env.EDGE_ADMIN_URL!.trim(), caddyfile: env.EDGE_CADDYFILE!.trim() };
}
