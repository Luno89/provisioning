import { parse, stringify } from 'yaml';

type Entry = { name?: unknown; context?: { cluster?: unknown; user?: unknown }; cluster?: Record<string, unknown>; user?: Record<string, unknown> };

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export function cleanKubeconfig(raw: string, server: string): string {
  const config = (parse(raw) ?? {}) as { 'current-context'?: unknown; contexts?: Entry[]; clusters?: Entry[]; users?: Entry[] };
  const context = (config.contexts ?? []).find((entry) => entry.name === config['current-context']) ?? config.contexts?.[0];
  const cluster = (config.clusters ?? []).find((entry) => entry.name === context?.context?.cluster)?.cluster ?? config.clusters?.[0]?.cluster ?? {};
  const user = (config.users ?? []).find((entry) => entry.name === context?.context?.user)?.user ?? config.users?.[0]?.user ?? {};
  const ca = text(cluster['certificate-authority-data']);
  const cert = text(user['client-certificate-data']);
  const key = text(user['client-key-data']);
  const token = text(user.token);
  if (!ca) throw new Error('the cluster\'s kubeconfig carries no certificate authority to trust');
  if (!(cert && key) && !token) throw new Error('the cluster\'s kubeconfig signs in neither with a client certificate nor a token');
  return stringify({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': 'koala',
    clusters: [{ name: 'koala', cluster: { server, 'certificate-authority-data': ca } }],
    users: [{ name: 'koala', user: cert && key ? { 'client-certificate-data': cert, 'client-key-data': key } : { token } }],
    contexts: [{ name: 'koala', context: { cluster: 'koala', user: 'koala' } }],
  });
}
