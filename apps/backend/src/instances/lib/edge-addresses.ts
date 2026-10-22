const LABEL_MAX = 63;

export const appLabel = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'app';

export const flatHost = (label: string, instance: string, domain: string): string => `${label}-${instance}.${domain}`;

export const nestedHost = (label: string, instance: string, domain: string): string => `${label}.${instance}.${domain}`;

export function labelOfFlat(host: string, instance: string, domain: string): string | undefined {
  const suffix = `-${instance}.${domain}`;
  return host.endsWith(suffix) && host.length > suffix.length ? host.slice(0, -suffix.length) : undefined;
}

export type AddressScope = { kind: 'group' | 'instance' | 'combined'; name: string };

export const idFragment = (deploymentId: string): string => deploymentId.replace(/-/g, '').slice(0, 6);

export function addressScope(given: { group?: string | undefined; instance?: string | undefined; deploymentId: string }): AddressScope {
  if (given.group) return { kind: 'group', name: given.group };
  if (given.instance) return { kind: 'instance', name: given.instance };
  return { kind: 'combined', name: idFragment(given.deploymentId) };
}

export const inScope = (host: string, scope: AddressScope, domain: string): boolean => labelOfFlat(host, scope.name, domain) !== undefined;

export const offersNested = (scope: AddressScope): boolean => scope.kind === 'instance';

export function freeLabel(wanted: string, instance: string, taken: ReadonlySet<string>): string {
  const room = LABEL_MAX - instance.length - 1;
  const base = wanted.slice(0, room).replace(/-$/, '') || 'app';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, room - suffix.length).replace(/-$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function edgeSite(hosts: readonly string[], backendTarget: string, appHostname: string): string {
  return `${hosts.map((host) => `http://${host}`).join(', ')} {
	reverse_proxy ${backendTarget} {
		header_up Host ${appHostname}
		header_up X-Forwarded-Proto https
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
}
`;
}
