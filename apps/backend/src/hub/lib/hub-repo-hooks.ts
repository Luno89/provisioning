import crypto from 'node:crypto';
import { ringOf, type SecretKey } from '@koala/engine-core/payloads';

export const HUB_REPO_HOOK_PATH = '/webhooks/hub-repo';

export const hubRepoHookSecret = (secret: string, projectId: string): string =>
  Buffer.from(crypto.hkdfSync('sha256', secret, 'nowrinkles-hub-repo-hook', projectId, 32)).toString('hex');

export function hubRepoHookSecrets(key: SecretKey, projectId: string): string[] {
  const ring = ringOf(key);
  return [ring.current, ...(ring.previous ?? [])].map((secret) => hubRepoHookSecret(secret, projectId));
}

export const hubRepoHookUrl = (backend: string, projectId: string): string => `${backend.replace(/\/+$/, '')}${HUB_REPO_HOOK_PATH}/${encodeURIComponent(projectId)}`;
