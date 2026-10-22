import { describe, it, expect } from 'vitest';
import { createSlotCluster, preparedNamespace, releaseNamespace } from './slot-cluster.js';
import { REGISTRY_PULL_SECRET } from '../../instances/lib/registry-pull.js';

describe('the namespace a release is installed in', () => {
  it('carries its owner and project, so removing either finds it', () => {
    expect(releaseNamespace({ namespace: 'shop-1a2b3c', owner: { ownerId: 'BO_1', projectId: 'project-p1' } })).toEqual({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'shop-1a2b3c', labels: { 'koala.dev/owner': 'bo_1', 'koala.dev/project': 'project-p1' } },
    });
  });

  it('is still named for a release started before releases said whose they are', () => {
    expect(releaseNamespace({ namespace: 'shop' })).toEqual({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } });
  });
});

describe('a release namespace pulls Koala-built images with a login', () => {
  const login = { hosts: { push: '10.0.0.130:31737', pull: '10.0.0.130:31737' }, username: 'provisioning-bot', password: 'tok' };
  const target = { clusterName: 'own', provider: 'remote', kubeconfigPath: '/kube/own', namespace: 'shop-1a2b3c', release: 'shop-1a2b3c', owner: { ownerId: 'BO_1', projectId: 'project-p1' } };

  const fakeInfra = () => {
    const applied: Record<string, unknown>[] = [];
    const infra = {
      applyManifest: async (manifest: string) => { applied.push(JSON.parse(manifest) as Record<string, unknown>); return ''; },
      runKubectl: async (args: string[]) => {
        if (args.includes('jsonpath={.status.succeeded}|{.status.failed}')) return '1|0';
        if (args.includes('jsonpath={.data}')) return JSON.stringify({ POSTGRES_PASSWORD: 'eA==' });
        return '';
      },
    };
    return { infra, applied };
  };

  const prepared = (manifest: Record<string, unknown> | undefined) =>
    ((manifest?.items ?? []) as Record<string, unknown>[]).map((item) => `${item.kind}/${(item.metadata as { name: string }).name}`);

  it('names the namespace, its pull secret and its default service account in one list', () => {
    const list = preparedNamespace(target, login);
    expect(prepared(list)).toEqual(['Namespace/shop-1a2b3c', `Secret/${REGISTRY_PULL_SECRET}`, 'ServiceAccount/default']);
    expect((list.items as Record<string, unknown>[])[2]).toMatchObject({ metadata: { namespace: 'shop-1a2b3c' }, imagePullSecrets: [{ name: REGISTRY_PULL_SECRET }] });
  });

  it('is prepared before a job, a put and the vault, each with the login it is handed', async () => {
    const { infra, applied } = fakeInfra();
    const asked: string[] = [];
    const cluster = createSlotCluster({
      infra: infra as never,
      repo: async () => ({ listPaths: async () => [], getRawFile: async () => null }),
      registry: async () => { asked.push('login'); return login; },
      syncVault: async () => undefined,
    });

    await cluster.job(target, 'shop-init', { apiVersion: 'batch/v1', kind: 'Job', metadata: {}, spec: {} });
    expect(prepared(applied[0])).toEqual(['Namespace/shop-1a2b3c', `Secret/${REGISTRY_PULL_SECRET}`, 'ServiceAccount/default']);
    expect(applied[1]).toMatchObject({ kind: 'Job', metadata: { name: 'shop-init', namespace: 'shop-1a2b3c' } });

    applied.length = 0;
    await cluster.put(target, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' } });
    expect(prepared(applied[0])).toContain('ServiceAccount/default');

    applied.length = 0;
    await cluster.vault(target, { projectId: 'project-p1', secret: 'shop-vault', keys: ['POSTGRES_PASSWORD'] } as never, {} as never);
    expect(prepared(applied[0])).toContain(`Secret/${REGISTRY_PULL_SECRET}`);
    expect(asked).toHaveLength(3);
  });
});
