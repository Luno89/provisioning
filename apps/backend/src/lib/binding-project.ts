import type { ResolvedBinding } from './binding-resolve.js';

export type Kubectl = (args: string[]) => Promise<string>;

export async function readBindingCredentials(
  kubectl: Kubectl,
  binding: Pick<ResolvedBinding, 'source'>,
): Promise<Record<string, string>> {
  const raw = await kubectl(
    ['get', 'secret', binding.source.secretName, '-n', binding.source.namespace, '-o', 'json'],
  ).catch(() => '');

  const data: Record<string, unknown> = (() => {
    try { return JSON.parse(raw || '{}')?.data ?? {}; } catch { return {}; }
  })();

  const credentials: Record<string, string> = {};
  for (const [bindingKey, sourceKey] of Object.entries(binding.source.keys)) {
    const value = data[sourceKey];
    if (typeof value === 'string') credentials[bindingKey] = Buffer.from(value, 'base64').toString('utf8');
  }
  return credentials;
}
