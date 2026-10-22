
const CLUSTER_DOMAIN = 'svc.cluster.local';

export interface ClusterAddress {
  service: string;
  namespace: string;
  port: number;
}

export function clusterHost(service: string, namespace: string): string {
  return `${service}.${namespace}.${CLUSTER_DOMAIN}`;
}

export function clusterAuthority(address: ClusterAddress): string {
  return `${clusterHost(address.service, address.namespace)}:${address.port}`;
}

export function clusterUrl(
  address: ClusterAddress,
  opts: { scheme?: string; path?: string } = {},
): string {
  const { scheme = 'http', path = '' } = opts;
  return `${scheme}://${clusterAuthority(address)}${path}`;
}
