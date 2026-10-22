import { decryptValue, encryptValue, looksEncrypted, type SecretKey } from '../../platform/lib/crypto.js';
import type { DeploymentMetadata } from '../../platform/index.js';

export const DEPLOYMENT_SECRET_FIELDS = [
  'vllmHfToken',
  'tabbyHfToken',
  'searxngSecretKey',
  'crawl4aiApiToken',
  'minioRootPassword',
  'nextcloudAdminPassword',
  'nextcloudDbPassword',
  'nextcloudDbRootPassword',
  'qdrantApiKey',
  'quickwitS3SecretKey',
  'webuiWebSearchApiKey',
] as const satisfies readonly (keyof DeploymentMetadata)[];

export type DeploymentSecretField = (typeof DEPLOYMENT_SECRET_FIELDS)[number];

const mapSecrets = <T extends object>(record: T, change: (value: string) => string): T => {
  let changed: Record<string, unknown> | undefined;
  for (const field of DEPLOYMENT_SECRET_FIELDS) {
    const value = (record as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value === '') continue;
    const next = change(value);
    if (next === value) continue;
    changed ??= { ...(record as Record<string, unknown>) };
    changed[field] = next;
  }
  return (changed as T | undefined) ?? record;
};

export const sealDeployment = <T extends object>(record: T, key: SecretKey): T =>
  mapSecrets(record, (value) => (looksEncrypted(value) ? value : encryptValue(value, key)));

export const unsealDeployment = <T extends object>(record: T, key: SecretKey): T =>
  mapSecrets(record, (value) => (looksEncrypted(value) ? decryptValue(value, key) : value));

export const hasPlainSecret = (record: Readonly<Record<string, unknown>>): boolean =>
  DEPLOYMENT_SECRET_FIELDS.some((field) => {
    const value = record[field];
    return typeof value === 'string' && value !== '' && !looksEncrypted(value);
  });
