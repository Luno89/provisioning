import { describe, it, expect } from 'vitest';
import { resolveMinioDefaults, resolveQdrantDefaults, resolveQuickwitDefaults } from './app-env.js';
import { appTypeFromName, isAppType, APP_TYPES } from './app-catalog.js';
import { describeSandbox } from './workspace-spec.js';
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

  it('accepts a MinIO that is still deploying, because what it needs is the keys', () => {
    /**
     * The obvious gate is `status === 'running'`, and it is wrong: the record reaches that state
     * when the deploy workflow finishes reconciling, which lags the pod being ready. Deploying
     * MinIO, watching it go 1/1 and then deploying Quickwit was refused with "deploy minio first"
     * — advice that had just been followed.
     */
    const deploying = { ...minio, status: 'deploying' } as DeploymentMetadata;
    expect(resolveQuickwitDefaults(dep({ appType: 'quickwit' }), [deploying]).quickwitS3SecretKey)
      .toBe('the-real-password');
  });

  it('skips a MinIO that is on its way out', () => {
    const going = { ...minio, status: 'destroying' } as DeploymentMetadata;
    expect(() => resolveQuickwitDefaults(dep({ appType: 'quickwit' }), [going])).toThrow();
  });

  it('says so when a MinIO exists but its credentials were never stored', () => {
    // A different failure needing a different fix, and "deploy minio first" would be wrong advice
    // for it.
    // The key is removed rather than set to undefined: under exactOptionalPropertyTypes those are
    // different things, and only one of them is what an unset field actually looks like.
    const { minioRootPassword, ...noCreds } = minio;
    expect(() => resolveQuickwitDefaults(dep({ appType: 'quickwit' }), [noCreds]))
      .toThrow(/credentials are not stored/i);
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

describe('what the sandbox tells the agent about installing', () => {
  it('says installs fail when nothing is reachable', () => {
    expect(describeSandbox({})).toMatch(/npm install.*WILL fail/i);
  });

  it('still says so when the only egress is a service, not a registry', () => {
    // Gitea is reachable and a registry is not — the agent must not infer one from the other.
    const out = describeSandbox({ egress: [{ namespace: 'gitea', ports: [3000] }] });
    expect(out).toMatch(/the gitea service/);
    expect(out).toMatch(/WILL fail/i);
  });

  it('says npm install works once a registry is injected', () => {
    /**
     * The sentence is an INSTRUCTION, and it was true until a mirror was deployed in-cluster. An
     * agent that still believes it hand-rolls what it could have installed.
     */
    const out = describeSandbox({
      egress: [{ namespace: 'koala-registry', ports: [4873] }],
      env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://verdaccio.koala-registry.svc.cluster.local:4873' }],
    });
    expect(out).toMatch(/`npm install` works/);
    expect(out).toContain('http://verdaccio.koala-registry.svc.cluster.local:4873');
    expect(out).not.toMatch(/WILL fail/i);
  });
});
