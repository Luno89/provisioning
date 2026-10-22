import { describe, expect, it } from 'vitest';
import { looksEncrypted, type SecretKey } from '../../platform/lib/crypto.js';
import { DEPLOYMENT_SECRET_FIELDS, hasPlainSecret, sealDeployment, unsealDeployment } from './deployment-secrets.js';

const key = 'a-test-key-that-is-at-least-thirty-two-characters' as unknown as SecretKey;

describe('a deployment\'s secrets at rest', () => {
  it('seals every secret field and leaves the rest as it is', () => {
    const dep = { id: 'd1', name: 'minio', minioRootUser: 'koala', minioRootPassword: 'hunter2', qdrantApiKey: 'q-key', minioStorage: '10Gi' };
    const sealed = sealDeployment(dep, key);
    expect(sealed.minioRootUser).toBe('koala');
    expect(sealed.minioStorage).toBe('10Gi');
    expect(looksEncrypted(sealed.minioRootPassword)).toBe(true);
    expect(looksEncrypted(sealed.qdrantApiKey)).toBe(true);
    expect(sealed.minioRootPassword).not.toBe('hunter2');
    expect(unsealDeployment(sealed, key)).toEqual(dep);
  });

  it('seals once: a value already sealed is kept, and an empty or missing one is left alone', () => {
    const sealed = sealDeployment({ minioRootPassword: 'hunter2', nextcloudAdminPassword: '' }, key);
    const again = sealDeployment(sealed, key);
    expect(again).toBe(sealed);
    expect(again.nextcloudAdminPassword).toBe('');
    expect(sealDeployment({ name: 'plain' }, key)).toEqual({ name: 'plain' });
  });

  it('reads a record from before sealing as it is, so nothing stored plain is lost', () => {
    const old = { minioRootPassword: 'plain-from-before' };
    expect(unsealDeployment(old, key)).toBe(old);
    expect(hasPlainSecret(old)).toBe(true);
    expect(hasPlainSecret(sealDeployment(old, key))).toBe(false);
    expect(hasPlainSecret({ name: 'x', minioRootUser: 'koala' })).toBe(false);
  });

  it('covers every password, token and key a deployment carries', () => {
    expect([...DEPLOYMENT_SECRET_FIELDS].sort()).toEqual([
      'crawl4aiApiToken', 'minioRootPassword', 'nextcloudAdminPassword', 'nextcloudDbPassword', 'nextcloudDbRootPassword',
      'qdrantApiKey', 'quickwitS3SecretKey', 'searxngSecretKey', 'tabbyHfToken', 'vllmHfToken', 'webuiWebSearchApiKey',
    ]);
  });
});
