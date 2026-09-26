import type { SecretRequest, SecretRequestStatus } from '@koala/harness-types';

export type { SecretRequest, SecretRequestStatus } from '@koala/harness-types';

export const MAX_SECRET_KEY = 128;
export const MAX_SECRET_DESCRIPTION = 500;
export const MAX_SECRET_VALUE = 64 * 1024;

export const secretReference = (projectId: string, key: string): string => `secret://${projectId}/${key}`;

export function keyProblem(key: string): string | undefined {
  if (!key) return 'a secret needs a key: the environment variable name the deployed service reads';
  if (key.length > MAX_SECRET_KEY) return `a secret key is at most ${MAX_SECRET_KEY} characters`;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    return `"${key}" is not an environment variable name — use upper case letters, digits and underscores, like DATABASE_URL`;
  }
  return undefined;
}

export function descriptionProblem(description: string): string | undefined {
  if (!description) return 'say what the secret is for and where the person can find it, so they know what to enter';
  if (description.length > MAX_SECRET_DESCRIPTION) return `the description is at most ${MAX_SECRET_DESCRIPTION} characters`;
  return undefined;
}

export function valueProblem(value: string): string | undefined {
  if (!value) return 'the secret is empty';
  if (value.length > MAX_SECRET_VALUE) return `a secret is at most ${MAX_SECRET_VALUE / 1024} KiB`;
  return undefined;
}

export const OPEN: readonly SecretRequestStatus[] = ['requested'];
export const SETTLED: readonly SecretRequestStatus[] = ['provided', 'provisioned'];

export function withRequired(
  required: readonly { key: string; source: string }[] | undefined,
  key: string,
  source: string,
): { key: string; source: string }[] {
  const rest = (required ?? []).filter((entry) => entry.key !== key);
  return [...rest, { key, source }];
}

export interface SecretSource {
  id: string;
  label: string;
  matches(key: string): boolean;
}

const segments = (key: string): string[] => key.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

export const GITEA_READ_TOKEN: SecretSource = {
  id: 'gitea-read-token',
  label: 'a read-only Gitea token minted for this person',
  matches: (key) => {
    const parts = segments(key);
    return (parts.includes('GITEA') || parts.includes('GIT')) && parts.includes('TOKEN');
  },
};

export const SECRET_SOURCES: readonly SecretSource[] = [GITEA_READ_TOKEN];

export const sourceFor = (key: string): SecretSource | undefined => SECRET_SOURCES.find((source) => source.matches(key));
