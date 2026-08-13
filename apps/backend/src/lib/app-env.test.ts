import { describe, it, expect } from 'vitest';
import { resolveMinioDefaults, resolveQdrantDefaults, resolveQuickwitDefaults } from './app-env.js';
import { appTypeFromName, isAppType, APP_TYPES } from './app-catalog.js';
import type { DeploymentMetadata } from './types.js';

const dep = (over: Partial<DeploymentMetadata>): DeploymentMetadata => ({
  id: 'd1', name: 'x', clusterId: 'c1', status: 'running', ...over,
} as DeploymentMetadata);

describe('minting credentials before a deployment exists', () => {
  it('generates a MinIO password, because one made inside the construct is unknowable', () => {
    const out = resolveMinioDefaults(dep({ appType: 'minio' }));
    expect(out.minioRootPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(out.minioRootUser).toBe('koala');
  });

  it('keeps a password that was already stored, so a redeploy is not a lockout', () => {
    const out = resolveMinioDefaults(dep({ appType: 'minio', minioRootPassword: 'kept' }));
    expect(out.minioRootPassword).toBe('kept');
  });

  it('leaves other app types alone', () => {
    expect(resolveMinioDefaults(dep({ appType: 'qdrant' })).minioRootPassword).toBeUndefined();
    expect(resolveQdrantDefaults(dep({ appType: 'minio' })).qdrantApiKey).toBeUndefined();
  });

  it('generates a Qdrant key, because without one it serves unauthenticated', () => {
    expect(resolveQdrantDefaults(dep({ appType: 'qdrant' })).qdrantApiKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Quickwit, whose credentials are not its own', () => {
  const minio = dep({
    id: 'm1', name: 'koala-store', appType: 'minio', status: 'running',
    minioRootUser: 'koala', minioRootPassword: 'the-real-password',
  });

  it('takes the keys the MinIO beside it was actually deployed with', () => {
    /**
     * The whole point. Generating a fresh pair — which is what every other resolver here does —
     * produces a pod that starts, passes its liveness probe, and cannot read a single split.
     */
    const out = resolveQuickwitDefaults(dep({ appType: 'quickwit' }), [minio]);
    expect(out.quickwitS3SecretKey).toBe('the-real-password');
    expect(out.quickwitS3AccessKey).toBe('koala');
  });

  it('points at the in-cluster Service, not an ingress', () => {
    // Pod-to-pod: this must not depend on an ingress controller or a port-forward being up.
    const out = resolveQuickwitDefaults(dep({ appType: 'quickwit' }), [minio]);
    expect(out.quickwitS3Endpoint).toBe('http://minio.koala-store.svc.cluster.local:9000');
  });

  it('refuses to deploy when there is no MinIO, rather than deploying something inert', () => {
    expect(() => resolveQuickwitDefaults(dep({ appType: 'quickwit' }), []))
      .toThrow(/requires|required|Deploy minio first/i);
  });

  it('ignores a MinIO that is not running', () => {
    // A failed MinIO has credentials in its record but no server behind them.
    const stopped = { ...minio, status: 'failed' } as DeploymentMetadata;
    expect(() => resolveQuickwitDefaults(dep({ appType: 'quickwit' }), [stopped])).toThrow();
  });

  it('does not take another tenant\'s storage', () => {
    // A corpus is the tenant's. Borrowing another tenant's bucket credentials would be worse
    // than failing.
    const theirs = { ...minio, ownerId: 'them' } as DeploymentMetadata;
    expect(() => resolveQuickwitDefaults(dep({ appType: 'quickwit', ownerId: 'me' }), [theirs])).toThrow();
  });

  it('keeps explicit settings, so a corpus can point at storage outside the cluster', () => {
    const out = resolveQuickwitDefaults(
      dep({ appType: 'quickwit', quickwitS3Endpoint: 'https://s3.example', quickwitS3SecretKey: 'mine' }),
      [],
    );
    expect(out.quickwitS3Endpoint).toBe('https://s3.example');
  });
});

describe('the app catalog', () => {
  it('recognises a release or pod name', () => {
    expect(appTypeFromName('crawl4ai-59c75f5947')).toBe('crawl4ai');
    expect(appTypeFromName('odoo-1')).toBe('odoo');
    expect(appTypeFromName('nothing-here')).toBeUndefined();
  });

  it('prefers the longest match, so a short name cannot claim a longer one', () => {
    /**
     * `tei` is three characters. Matching shortest-first it would claim any name containing them,
     * and every one of these types is a substring test against a pod name.
     */
    expect(appTypeFromName('protein-service')).not.toBe('tei');
  });

  it('covers the search services', () => {
    for (const t of ['minio', 'qdrant', 'quickwit', 'tei']) expect(isAppType(t)).toBe(true);
    expect(isAppType('not-an-app')).toBe(false);
  });

  it('has no duplicates, which a hand-maintained list acquires', () => {
    expect(new Set(APP_TYPES).size).toBe(APP_TYPES.length);
  });
});
