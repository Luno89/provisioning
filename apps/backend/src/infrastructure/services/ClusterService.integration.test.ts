import { describe, it, expect } from 'vitest';
import { ClusterService } from './ClusterService.js';
import { InfrastructureService } from './InfrastructureService.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptValue } from '../../platform/lib/crypto.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { ClusterMetadata } from '../../platform/lib/types.js';
import { testClusterAccess } from '../testing/cluster-access.js';

const MASTER = 'test-master-key';

async function createService() {
  const db = await testDatabase();
  const kubeconfigDir = mkdtempSync(join(tmpdir(), 'cluster-service-'));
  const svc = new ClusterService(db, new InfrastructureService(), testClusterAccess(db, { dataKey: MASTER, folder: kubeconfigDir }), { kubeconfigDir });
  return { svc, db, kubeconfigDir };
}

describe('a machine\'s own cluster, stored', () => {
  it('opens the kubeconfig sealed on the stored record each time it is reached, so a new one the machine hands over is the one used', async () => {
    const { svc, db, kubeconfigDir } = await createService();
    const saved = await db.infrastructure.saveClusterInfo({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'healthy', ownerId: 'bo', machineId: 'desk', kubeconfigEnc: encryptValue('server: https://100.64.0.7:6443', MASTER) });
    const where = await svc.getKubeconfigPath(saved);
    expect(where).toBe(join(kubeconfigDir, 'kubeconfig-machine-machine-desk'));
    expect(readFileSync(where, 'utf8')).toContain('100.64.0.7');
    await db.infrastructure.saveClusterInfo({ id: 'machine-desk', kubeconfigEnc: encryptValue('server: https://100.64.0.8:6443', MASTER) });
    const again = (await db.infrastructure.getClusters()).find((cluster) => cluster.id === 'machine-desk')!;
    expect(readFileSync(await svc.getKubeconfigPath(again), 'utf8')).toContain('100.64.0.8');
  });
});

describe('reconciling clusters against k3d', () => {
  const k3d = (id: string, status: ClusterMetadata['status'] = 'healthy'): ClusterMetadata => ({ id, name: id, provider: 'k3d', status, ownerId: 'bo' });

  async function passWith(during: (db: MongoDB) => Promise<void>, running: string[]) {
    const db = await testDatabase();
    class K3dHere extends InfrastructureService {
      override async listLocalClusters(): Promise<string[]> { await during(db); return running; }
    }
    return { db, svc: new ClusterService(db, new K3dHere(), testClusterAccess(db, { dataKey: MASTER })) };
  }

  it('removes a cluster deleted outside Koala with its deployments, and nothing else', async () => {
    const { db, svc } = await passWith(async () => undefined, ['kept']);
    await db.infrastructure.saveCluster(k3d('kept'));
    await db.infrastructure.saveCluster(k3d('gone'));
    await db.infrastructure.saveCluster(k3d('leaving', 'destroying'));
    await db.infrastructure.saveDeployment({ id: 'app-gone', name: 'app-gone', clusterId: 'gone', strategy: 'helm', status: 'running' });
    await db.infrastructure.saveDeployment({ id: 'app-kept', name: 'app-kept', clusterId: 'kept', strategy: 'helm', status: 'running' });

    await svc.reconcileAllClusters();

    expect((await db.infrastructure.getClusters()).map((cluster) => cluster.id).sort()).toEqual(['kept', 'leaving']);
    expect((await db.infrastructure.getDeployments()).map((dep) => dep.id)).toEqual(['app-kept']);
  });

  it('keeps a cluster made while it was asking k3d, and a newer write to one it read', async () => {
    const { db, svc } = await passWith(async (store) => {
      await store.infrastructure.saveCluster(k3d('made-meanwhile', 'provisioning'));
      await store.infrastructure.patchCluster('kept', { meshIp: '100.64.0.9' });
    }, ['kept', 'made-meanwhile']);
    await db.infrastructure.saveCluster(k3d('kept'));
    await db.infrastructure.saveCluster(k3d('gone'));

    await svc.reconcileAllClusters();

    const clusters = await db.infrastructure.getClusters();
    expect(clusters.map((cluster) => cluster.id).sort()).toEqual(['kept', 'made-meanwhile']);
    expect(clusters.find((cluster) => cluster.id === 'kept')?.meshIp).toBe('100.64.0.9');
  });
});

describe('Koala\'s own cluster on a machine, stored', () => {
  it('is the stored machine cluster, listed once and first, running, and no other id reaches it', async () => {
    const db = await testDatabase();
    class OwnCluster extends InfrastructureService {
      override async listLocalClusters(): Promise<string[]> { return []; }
      override async runKubectl(): Promise<string> { return JSON.stringify({ items: [] }); }
    }
    const svc = new ClusterService(db, new OwnCluster(), testClusterAccess(db, { dataKey: MASTER, koalaMachineId: 'desk', serviceAccount: { host: 'kubernetes.default.svc', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' } }), { kubeconfigDir: mkdtempSync(join(tmpdir(), 'cluster-service-')), instanceOwnerId: 'bo' });
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'desk' });
    await db.infrastructure.saveCluster({ id: 'machine-nas', name: 'nas', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'nas' });
    expect((await svc.reconcileAllClusters()).map((cluster) => [cluster.id, cluster.status])).toEqual([['machine-desk', 'healthy'], ['machine-nas', 'stopped']]);
    expect((await svc.getByIdUnscoped('machine-desk'))?.status).toBe('healthy');
    expect(await svc.getByIdUnscoped('provisioning-lunorica')).toBeUndefined();
    expect((await svc.clustersOwnedBy('bo')).map((cluster) => cluster.id)).toEqual(['machine-desk', 'machine-nas']);
  });
});
