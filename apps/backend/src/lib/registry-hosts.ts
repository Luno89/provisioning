export interface RegistryHosts {
  pull: string;
  push: string;
}

export const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/+$/, '');

export function registryHosts(pushUrl: string, pullHost: string | undefined): RegistryHosts {
  const push = hostOf(pushUrl);
  return { push, pull: pullHost?.trim() ? hostOf(pullHost) : push };
}

export function forPushing(reference: string, hosts: RegistryHosts): string {
  return hosts.pull !== hosts.push && reference.startsWith(`${hosts.pull}/`)
    ? `${hosts.push}/${reference.slice(hosts.pull.length + 1)}`
    : reference;
}

export function kanikoRegistryArgs(hosts: RegistryHosts): string[] {
  return hosts.pull === hosts.push ? [] : [`--registry-map=${hosts.pull}=${hosts.push}`, `--insecure-registry=${hosts.push}`];
}

export function registryAuths(hosts: RegistryHosts, auth: string): Record<string, { auth: string }> {
  return hosts.pull === hosts.push ? { [hosts.push]: { auth } } : { [hosts.push]: { auth }, [hosts.pull]: { auth } };
}
