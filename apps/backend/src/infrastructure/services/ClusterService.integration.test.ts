import { describe, it, expect } from 'vitest';
import { ClusterService } from './ClusterService.js';
import { InfrastructureService } from './InfrastructureService.js';
import { decryptValue } from '../../platform/lib/crypto.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { ClusterMetadata } from '../../platform/lib/types.js';

const MASTER = 'test-master-key';

async function createService() {
  const db = await testDatabase();
  const svc = new ClusterService(db, new InfrastructureService(), MASTER);
  return { svc, saved: () => db.infrastructure.getClusters() };
}

describe('createAwaitingKey', () => {
  const args = {
    name: 'gpu-box',
    ownerId: 'user-1',
    host: '100.64.0.9',
    username: 'root',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-material\n-----END OPENSSH PRIVATE KEY-----',
  };

  it('never stores the private key in plaintext', async () => {
    const { svc, saved } = await createService();
    await svc.createAwaitingKey(args);

    const [record] = await saved();
    expect(JSON.stringify(record)).not.toContain('secret-material');
    expect(record?.remoteSshPrivateKeyEnc).toBeDefined();
    expect(decryptValue(record?.remoteSshPrivateKeyEnc ?? '', MASTER)).toBe(args.privateKey);
  });

  it('parks the cluster in awaiting-key rather than provisioning', async () => {
    const { svc, saved } = await createService();
    await svc.createAwaitingKey(args);
    expect((await saved())[0]?.status).toBe('awaiting-key');
  });

  it('records the connection details the start route will need', async () => {
    const { svc, saved } = await createService();
    await svc.createAwaitingKey({ ...args, port: 2222 });
    const [record] = await saved();
    expect(record).toMatchObject({
      provider: 'remote',
      ownerId: 'user-1',
      remoteHost: '100.64.0.9',
      remoteUsername: 'root',
      remoteSshPort: 2222,
    });
    expect(record?.id).toBeTruthy();
  });

  it('omits the port entirely when not given, rather than writing undefined', async () => {
    const { svc, saved } = await createService();
    await svc.createAwaitingKey(args);
    expect('remoteSshPort' in ((await saved())[0] ?? {})).toBe(false);
  });
});

describe('reconciling clusters against k3d', () => {
  const k3d = (id: string, status: ClusterMetadata['status'] = 'healthy'): ClusterMetadata => ({ id, name: id, provider: 'k3d', status, ownerId: 'bo' });

  async function passWith(during: (db: MongoDB) => Promise<void>, running: string[]) {
    const db = await testDatabase();
    class K3dHere extends InfrastructureService {
      override async listLocalClusters(): Promise<string[]> { await during(db); return running; }
      override async getManagementClusterKubeconfig(): Promise<string> { throw new Error('no management cluster here'); }
    }
    return { db, svc: new ClusterService(db, new K3dHere(), MASTER) };
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
