const LABEL_MAX = 63;

export const appLabel = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'app';

export const flatHost = (label: string, instance: string, domain: string): string => `${label}-${instance}.${domain}`;

export const nestedHost = (label: string, instance: string, domain: string): string => `${label}.${instance}.${domain}`;

export function labelOfFlat(host: string, instance: string, domain: string): string | undefined {
  const suffix = `-${instance}.${domain}`;
  return host.endsWith(suffix) && host.length > suffix.length ? host.slice(0, -suffix.length) : undefined;
}

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
