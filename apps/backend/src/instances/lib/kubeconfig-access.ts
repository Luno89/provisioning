import { parse } from 'yaml';

export interface KubeAccess {
  server: string;
  ca?: Buffer | undefined;
  cert?: Buffer | undefined;
  key?: Buffer | undefined;
  token?: string | undefined;
  insecure?: boolean | undefined;
}

interface Named<T> { name?: string; [key: string]: unknown; value?: T }

const fromB64 = (value: unknown): Buffer | undefined => (typeof value === 'string' && value ? Buffer.from(value, 'base64') : undefined);

export function kubeAccessFrom(text: string): KubeAccess {
  const config = parse(text) as {
    'current-context'?: string;
    contexts?: Array<Named<never> & { context?: { cluster?: string; user?: string } }>;
    clusters?: Array<Named<never> & { cluster?: Record<string, unknown> }>;
    users?: Array<Named<never> & { user?: Record<string, unknown> }>;
  };
  const context = (config.contexts ?? []).find((entry) => entry.name === config['current-context']) ?? config.contexts?.[0];
  const cluster = (config.clusters ?? []).find((entry) => entry.name === context?.context?.cluster)?.cluster ?? config.clusters?.[0]?.cluster;
  const user = (config.users ?? []).find((entry) => entry.name === context?.context?.user)?.user ?? config.users?.[0]?.user ?? {};
  if (!cluster || typeof cluster.server !== 'string') throw new Error('the kubeconfig names no cluster to reach');
  return {
    server: cluster.server.replace(/\/$/, ''),
    ca: fromB64(cluster['certificate-authority-data']),
    cert: fromB64(user['client-certificate-data']),
    key: fromB64(user['client-key-data']),
    token: typeof user.token === 'string' ? user.token : undefined,
    insecure: cluster['insecure-skip-tls-verify'] === true,
  };
}

export function serviceProxyPath(namespace: string, service: string, port: number, path: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/http:${encodeURIComponent(service)}:${port}/proxy${path.startsWith('/') ? path : `/${path}`}`;
}
