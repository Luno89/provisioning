import { describe, it, expect } from 'vitest';
import { INFISICAL_IN_CLUSTER, infisicalHostFor, infisicalSecretManifest, readerSecretManifest } from './infisical-sync.js';

describe('where a cluster reaches the vault', () => {
  it('uses the in-cluster service on the management cluster', () => {
    expect(infisicalHostFor({ clusterName: 'provisioning-lunorica', provider: 'k3d', isMock: false })).toEqual({ hostAPI: INFISICAL_IN_CLUSTER });
  });

  it('uses the host NodePort from a k3d or mock cluster', () => {
    expect(infisicalHostFor({ clusterName: 'dev-1', provider: 'k3d', isMock: false })).toEqual({ hostAPI: 'http://host.k3d.internal:31738' });
    expect(infisicalHostFor({ clusterName: 'dev-2', provider: 'aws', isMock: true })).toEqual({ hostAPI: 'http://host.k3d.internal:31738' });
  });

  it('says so for a cluster that cannot reach it', () => {
    const remote = infisicalHostFor({ clusterName: 'gpu-box', provider: 'remote', isMock: false });
    expect(remote).toEqual({ problem: expect.stringContaining('gpu-box is a machine outside this node') });
    expect(infisicalHostFor({ clusterName: 'eks', provider: 'aws', isMock: false })).toEqual({ problem: expect.stringContaining('a cloud cluster') });
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
