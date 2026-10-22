import { describe, it, expect } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { AppService } from './AppService.js';

const at = 'then';

const serviceOn = async (namespaces: string[]) => {
  const db = await testDatabase();
  const cluster = { id: 'c1', name: 'system', provider: 'k3d', status: 'healthy', ownerId: 'bo' };
  const clusters = {
    reconcileAllClusters: async () => [cluster],
    getById: async () => cluster,
    getKubeconfigPath: async () => '/tmp/kubeconfig',
    isMockCloud: () => false,
    getPhysicalClusterName: () => cluster.name,
  };
  const infra = { runKubectl: async () => JSON.stringify({ items: namespaces.map((name) => ({ metadata: { name } })) }) };
  return { db, apps: new AppService(db, infra as never, clusters as never, {} as never) };
};

describe('listing apps against the cluster', () => {
  it('keeps an app whose release lives in a namespace of its own name, and drops one whose namespace is gone', async () => {
    const { db, apps } = await serviceOn(['shop-1a2b3c', 'wordpress']);
    await db.saveDeploymentInfo({ id: 'odoo-p1', name: 'Shop', namespace: 'shop-1a2b3c', clusterId: 'c1', strategy: 'helm', appType: 'odoo-project', ownerId: 'bo', status: 'running', createdAt: at });
    await db.saveDeploymentInfo({ id: 'wp', name: 'WordPress', clusterId: 'c1', strategy: 'helm', appType: 'wordpress', ownerId: 'bo', status: 'running', createdAt: at });
    await db.saveDeploymentInfo({ id: 'gone', name: 'Gone', clusterId: 'c1', strategy: 'helm', appType: 'wordpress', ownerId: 'bo', status: 'running', createdAt: at });

    expect((await apps.getAll('bo')).map((app) => app.id)).toEqual(['odoo-p1', 'wp']);
    expect((await db.getDeployments()).map((app) => app.id)).toEqual(['odoo-p1', 'wp']);
  });

  it('keeps an app that failed before its namespace was made, so the person still sees it failed', async () => {
    const { db, apps } = await serviceOn([]);
    await db.saveDeploymentInfo({ id: 'books', name: 'Books', clusterId: 'c1', strategy: 'native', appType: 'audiobookshelf', ownerId: 'bo', status: 'failed', createdAt: at });

    expect((await apps.getAll('bo')).map((app) => [app.id, app.status])).toEqual([['books', 'failed']]);
  });

  it('does not discover again a release it already tracks under a namespace of its own name', async () => {
    const { db, apps } = await serviceOn(['shop-1a2b3c', 'stray']);
    await db.saveDeploymentInfo({ id: 'odoo-p1', name: 'Shop', namespace: 'shop-1a2b3c', clusterId: 'c1', strategy: 'helm', appType: 'odoo-project', ownerId: 'bo', status: 'running', createdAt: at });
    const found = await apps.discoverDeployments('c1', 'bo');
    expect(found.map((app) => app.name)).toEqual(['stray']);
  });
});
