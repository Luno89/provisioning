import type { ResolvedBinding } from '../../infrastructure/index.js';

export type Kubectl = (args: string[]) => Promise<string>;

const secretDataOf = (raw: string): Record<string, unknown> => {
  const parsed = JSON.parse(raw || '{}') as unknown;
  const data = parsed && typeof parsed === 'object' ? (parsed as { data?: unknown }).data : undefined;
  return data && typeof data === 'object' ? data as Record<string, unknown> : {};
};

export async function readBindingCredentials(
  kubectl: Kubectl,
  binding: Pick<ResolvedBinding, 'source'>,
): Promise<Record<string, string>> {
  const { secretName, namespace } = binding.source;
  const unread = (err: unknown): Record<string, unknown> => {
    console.warn(`[bindings] could not read the Secret ${namespace}/${secretName}, so its credentials are left out: ${(err as Error).message}`);
    return {};
  };
  const data = await kubectl(['get', 'secret', secretName, '-n', namespace, '-o', 'json'])
    .then(secretDataOf)
    .catch(unread);

  const credentials: Record<string, string> = {};
  for (const [bindingKey, sourceKey] of Object.entries(binding.source.keys)) {
    const value = data[sourceKey];
    if (typeof value === 'string') credentials[bindingKey] = Buffer.from(value, 'base64').toString('utf8');
  }
  return credentials;
}
