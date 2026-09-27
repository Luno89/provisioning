import { createHash, createHmac } from 'node:crypto';

export const PROXY_ADDRESS = 'egress-proxy.koala-egress.svc.cluster.local:8888';
export const DEFAULT_PORTS = [443] as const;

export interface GrantedAccess {
  ownerId: string;
  agentSlug: string;
  host: string;
  ports?: readonly number[] | undefined;
}

export const proxyUser = (ownerId: string, agentSlug: string): string =>
  `a${createHash('sha256').update(`${ownerId}/${agentSlug}`).digest('hex').slice(0, 20)}`;

export const proxyPassword = (secret: string, user: string): string =>
  createHmac('sha256', secret).update(`egress:${user}`).digest('hex').slice(0, 32);

export const proxyUrlFor = (secret: string, ownerId: string, agentSlug: string): string => {
  const user = proxyUser(ownerId, agentSlug);
  return `http://${user}:${proxyPassword(secret, user)}@${PROXY_ADDRESS}`;
};

export function hostProblem(host: string): string | undefined {
  if (!host) return 'name the host to reach, like api.stripe.com';
  if (host.length > 253) return 'that host name is too long';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'grant a host name, not an address — the proxy resolves names itself';
  if (!/^\.?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)) return `"${host}" is not a host name`;
  return undefined;
}

export function portsProblem(ports: readonly number[]): string | undefined {
  const bad = ports.find((port) => !Number.isInteger(port) || port < 1 || port > 65535);
  return bad === undefined ? undefined : `${bad} is not a port`;
}

export interface ProxyGrantFiles {
  users: { user: string; password: string }[];
  acls: string;
}

export function renderGrants(secret: string, grants: readonly GrantedAccess[]): ProxyGrantFiles {
  const byPersona = new Map<string, { user: string; hosts: Set<string>; ports: Set<number> }>();
  for (const grant of grants) {
    const user = proxyUser(grant.ownerId, grant.agentSlug);
    const entry = byPersona.get(user) ?? { user, hosts: new Set<string>(), ports: new Set<number>() };
    entry.hosts.add(grant.host.toLowerCase());
    for (const port of grant.ports?.length ? grant.ports : DEFAULT_PORTS) entry.ports.add(port);
    byPersona.set(user, entry);
  }

  const users = [...byPersona.values()].sort((a, b) => a.user.localeCompare(b.user));
  const acls = users.flatMap(({ user, hosts, ports }) => [
    `acl user_${user} proxy_auth ${user}`,
    `acl hosts_${user} dstdomain ${[...hosts].sort().join(' ')}`,
    `acl ports_${user} port ${[...ports].sort((a, b) => a - b).join(' ')}`,
    `http_access allow CONNECT user_${user} hosts_${user} ports_${user}`,
  ]).join('\n');

  return {
    users: users.map(({ user }) => ({ user, password: proxyPassword(secret, user) })),
    acls: acls ? `${acls}\n` : '',
  };
}
