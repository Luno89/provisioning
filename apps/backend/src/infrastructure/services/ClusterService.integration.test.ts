import { describe, it, expect } from 'vitest';
import { ClusterService } from './ClusterService.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptValue } from '../../platform/lib/crypto.js';
import { asPerson } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { testClusterAccess } from '../testing/cluster-access.js';

const MASTER = 'test-master-key';

async function createService() {
  const db = await testDatabase();
  const kubeconfigDir = mkdtempSync(join(tmpdir(), 'cluster-service-'));
  const svc = new ClusterService(db, testClusterAccess(db, { dataKey: MASTER, folder: kubeconfigDir }));
  return { svc, db, kubeconfigDir };
}

describe('a machine\'s own cluster, stored', () => {
  it('opens the kubeconfig sealed on the stored record each time it is reached, so a new one the machine hands over is the one used', async () => {
    const { svc, db, kubeconfigDir } = await createService();
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'healthy', ownerId: 'bo', machineId: 'desk', kubeconfigEnc: encryptValue('server: https://100.64.0.7:6443', MASTER) });
    const where = await svc.access.kubeconfigOf('machine-desk');
    expect(where).toBe(join(kubeconfigDir, 'kubeconfig-machine-machine-desk'));
    expect(readFileSync(where, 'utf8')).toContain('100.64.0.7');
    await db.infrastructure.patchCluster('machine-desk', { kubeconfigEnc: encryptValue('server: https://100.64.0.8:6443', MASTER) });
    expect(readFileSync(await svc.access.kubeconfigOf('machine-desk'), 'utf8')).toContain('100.64.0.8');
  });
});

describe('Koala\'s own cluster on a machine, stored', () => {
  it('is the stored machine cluster, listed once and first, running, and no other id reaches it', async () => {
    const db = await testDatabase();
    const svc = new ClusterService(db, testClusterAccess(db, { answers: async () => JSON.stringify({ items: [] }), dataKey: MASTER, koalaMachineId: 'desk', serviceAccount: { host: 'kubernetes.default.svc', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' } }), { instanceOwnerId: 'bo' });
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'desk' });
    await db.infrastructure.saveCluster({ id: 'machine-nas', name: 'nas', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'nas' });
    expect((await svc.getAll(asPerson('bo'))).map((cluster) => [cluster.id, cluster.status])).toEqual([['machine-desk', 'healthy'], ['machine-nas', 'stopped']]);
    expect((await svc.getByIdUnscoped('machine-desk'))?.status).toBe('healthy');
    expect(await svc.getByIdUnscoped('provisioning-lunorica')).toBeUndefined();
    expect((await svc.clustersOwnedBy('bo')).map((cluster) => cluster.id)).toEqual(['machine-desk', 'machine-nas']);
  });
});
