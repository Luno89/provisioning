import { describe, expect, it, vi } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { ClusterMetadata } from '../../platform/lib/types.js';
import { encryptValue } from '../../platform/lib/crypto.js';
import { startAppDeploy, type AppDeployDeps } from './AppDeploy.js';
import { testClusterAccess } from '../testing/cluster-access.js';

const CLUSTER: ClusterMetadata = { id: 'c1', name: 'shared', provider: 'machine', machineId: 'dev2', status: 'healthy' } as ClusterMetadata;

async function deps(): Promise<{ deps: AppDeployDeps; started: { workflowId: string; args: Record<string, unknown> }[] }> {
  const db = await testDatabase();
  await db.infrastructure.saveCluster(CLUSTER);
  const started: { workflowId: string; args: Record<string, unknown> }[] = [];
  const start = vi.fn(async (_workflow: unknown, options: { workflowId: string; args: [Record<string, unknown>] }) => {
    started.push({ workflowId: options.workflowId, args: options.args[0] });
    return {};
  });
  return {
    deps: {
      db,
      client: () => ({ workflow: { start } }) as never,
      masterKey: 'test-key-that-is-at-least-32-characters-long' as never,
      clusterById: async (id) => (id === CLUSTER.id ? CLUSTER : undefined),
      handOver: (clusterId) => testClusterAccess(db).handOver(clusterId),
      logDir: '/tmp',
      ownClusterId: () => undefined,
    },
    started,
  };
}

describe('two people can each have an app called shop', () => {
  it('gives each owner their own record, id and namespace on the same cluster', async () => {
    const { deps: d, started } = await deps();
    const ann = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');
    const bob = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'bob');

    expect(ann.deployment.id).not.toBe('shop');
    expect(ann.deployment.id).not.toBe(bob.deployment.id);
    expect(ann.deployment.namespace).toMatch(/^shop-[a-f0-9]{6}$/);
    expect(bob.deployment.namespace).toMatch(/^shop-[a-f0-9]{6}$/);
    expect(ann.deployment.namespace).not.toBe(bob.deployment.namespace);

    const saved = await d.db.infrastructure.getDeployments();
    expect(saved.map((dep) => [dep.ownerId, dep.name, dep.namespace]).sort()).toEqual([
      ['ann', 'shop', ann.deployment.namespace],
      ['bob', 'shop', bob.deployment.namespace],
    ]);
    expect(started.map((run) => run.args.namespace)).toEqual([ann.deployment.namespace, bob.deployment.namespace]);
    expect(started[0]!.args).toMatchObject({ clusterId: 'c1', machine: { deviceId: 'dev2' } });
  });

  it('deploying the same app again as its owner reuses the record, not another owner\'s', async () => {
    const { deps: d } = await deps();
    const first = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');
    await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'bob');
    const again = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');

    expect(again.deployment.id).toBe(first.deployment.id);
    expect(again.deployment.namespace).toBe(first.deployment.namespace);
    expect((await d.db.infrastructure.getDeployments()).length).toBe(2);
  });

  it('the database refuses one owner two apps of one name and allows two owners one each', async () => {
    const { deps: d } = await deps();
    await d.db.infrastructure.saveDeployment({ id: 'a', name: 'shop', clusterId: 'c1', strategy: 'helm', status: 'running', ownerId: 'ann' });
    await d.db.infrastructure.saveDeployment({ id: 'b', name: 'shop', clusterId: 'c2', strategy: 'helm', status: 'running', ownerId: 'bob' });
    await expect(d.db.infrastructure.saveDeployment({ id: 'c', name: 'shop', clusterId: 'c2', strategy: 'helm', status: 'running', ownerId: 'ann' }))
      .rejects.toThrow(/duplicate key/);
  });

  it('stores a new app under the cluster\'s own id, however the request named it', async () => {
    const { deps: d } = await deps();
    const named = await startAppDeploy({ ...d, clusterById: async (id) => (id === 'by-another-name' ? CLUSTER : undefined) }, { name: 'blog', clusterId: 'by-another-name', appType: 'wordpress' });
    expect((await d.db.infrastructure.getDeployments()).find((entry) => entry.id === named.deployment.id)?.clusterId).toBe('c1');
  });
});

describe('a model\'s Hugging Face token', () => {
  it('is the one given with the deploy, else the person\'s saved token read back from the database, else none', async () => {
    const { deps: d, started } = await deps();
    await d.db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { huggingface: { hfToken: encryptValue('hf_saved', d.masterKey) } } });
    await d.db.accounts.saveUser({ id: 'bob', email: 'bob@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'x' });
    await startAppDeploy(d, { name: 'given', clusterId: 'c1', appType: 'vllm', vllmHfToken: 'hf_given' }, 'ann');
    await startAppDeploy(d, { name: 'saved', clusterId: 'c1', appType: 'tabbyapi' }, 'ann');
    await startAppDeploy(d, { name: 'none', clusterId: 'c1', appType: 'vllm' }, 'bob');

    expect(started.map((run) => [run.args.vllmHfToken, run.args.tabbyHfToken])).toEqual([['hf_given', undefined], [undefined, 'hf_saved'], [undefined, undefined]]);
    const stored = Object.fromEntries((await d.db.infrastructure.getDeployments()).map((dep) => [dep.name, [dep.vllmHfToken, dep.tabbyHfToken]]));
    expect(stored).toEqual({ given: ['hf_given', undefined], saved: [undefined, 'hf_saved'], none: [undefined, undefined] });
  });
});
