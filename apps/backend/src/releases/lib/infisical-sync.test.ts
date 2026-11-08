import { containing } from '../../platform/lib/test-matchers.js';
import { describe, it, expect } from 'vitest';
import { infisicalHostFor, infisicalSecretManifest, readerSecretManifest } from './infisical-sync.js';

describe('where a cluster reaches the vault', () => {
  const VAULT = { url: 'http://infisical-infisical-standalone-infisical.infisical.svc.cluster.local:8080' };

  it('is the address the vault setting names, on Koala\'s own cluster', () => {
    expect(infisicalHostFor({ clusterId: 'machine-dev1', kind: 'koala' }, VAULT)).toEqual({ hostAPI: VAULT.url });
    expect(infisicalHostFor({ clusterId: 'machine-koala', kind: 'koala' }, { url: 'http://vault.test:8080' })).toEqual({ hostAPI: 'http://vault.test:8080' });
  });

  it('says so for a cluster that cannot reach it, whatever its name', () => {
    expect(infisicalHostFor({ clusterId: 'machine-gpu-box', kind: 'machine' }, VAULT)).toEqual({ problem: 'machine-gpu-box is a machine outside Koala\'s own cluster, and the vault in Koala\'s own cluster is not reachable from it, so its secrets cannot be delivered' });
    expect(infisicalHostFor({ clusterId: 'machine-koala', kind: 'machine' }, VAULT)).toEqual({ problem: containing('machine-koala is a machine outside Koala\'s own cluster') });
    expect(infisicalHostFor({ clusterId: 'root', kind: 'root' }, VAULT)).toEqual({ problem: containing('root is root\'s own cluster, which keeps no project\'s secrets') });
  });
});

describe('the manifests', () => {
  it('scopes the InfisicalSecret to the project workspace and manages <namespace>-secrets', () => {
    const manifest = infisicalSecretManifest({ namespace: 'billing', hostAPI: 'http://host.k3d.internal:31738', workspaceId: 'ws-1' });
    expect(manifest).toContain('hostAPI: "http://host.k3d.internal:31738/api"');
    expect(manifest).toContain('projectId: "ws-1"');
    expect(manifest).toContain('envSlug: "dev"');
    expect(manifest).toContain('secretsPath: "/"');
    expect(manifest).toContain('secretName: billing-secrets');
    expect(manifest).toContain('secretName: infisical-auth');
  });

  it('quotes the reader credential so no value can break out of the YAML', () => {
    const manifest = readerSecretManifest('billing', { clientId: 'id: x', clientSecret: 'a"b\nc' });
    expect(manifest).toContain('clientId: "id: x"');
    expect(manifest).toContain('clientSecret: "a\\"b\\nc"');
  });
});
