import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Server as SocketServer } from 'socket.io';
import { asPerson, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { seedAppSpecs } from '../lib/app-spec.js';
import { AppService } from './AppService.js';
import type { BuilderService } from './BuilderService.js';
import type { ClusterService } from './ClusterService.js';
import type { InfrastructureService } from './InfrastructureService.js';
import type { TemporalBridge } from './TemporalBridge.js';

const at = 'then';
const cluster: ClusterMetadata = { id: 'c1', name: 'system', provider: 'k3d', status: 'healthy', ownerId: 'bo' };
const namespaceList = (names: string[]): string => JSON.stringify({ items: names.map((name) => ({ metadata: { name } })) });
const app = (over: Partial<DeploymentMetadata> & Pick<DeploymentMetadata, 'id' | 'name'>): DeploymentMetadata => ({ clusterId: 'c1', strategy: 'helm', ownerId: 'bo', status: 'running', createdAt: at, ...over }) as DeploymentMetadata;

function setup(namespaces: string[] = [], clustersSeen: ClusterMetadata[] = [cluster]) {
  const db = memoryDatabase();
  const clusters = mock<ClusterService>();
  clusters.reconcileAllClusters.mockResolvedValue(clustersSeen);
  clusters.getById.mockResolvedValue(cluster);
  clusters.getKubeconfigPath.mockResolvedValue('/tmp/kubeconfig');
  clusters.isMockCloud.mockReturnValue(false);
  clusters.getPhysicalClusterName.mockReturnValue(cluster.name);
  const infra = mock<InfrastructureService>();
  infra.runKubectl.mockResolvedValue(namespaceList(namespaces));
  const apps = new AppService(db, infra, clusters, mock<BuilderService>());
  return { db, clusters, infra, apps };
}

describe('AppService.getById', () => {
  it('shows an app to its owner and as missing to anyone else', async () => {
    const { db, apps } = setup();
    await db.infrastructure.saveDeploymentInfo(app({ id: 'a1', name: 'Shop' }));
    expect((await apps.getById('a1', 'bo'))?.name).toBe('Shop');
    expect(await apps.getById('a1', 'someone-else')).toBeUndefined();
    expect(await apps.getById('nope', 'bo')).toBeUndefined();
  });
});

describe('listing apps against the cluster', () => {
  it('keeps an app whose release lives in a namespace of its own name, and drops one whose namespace is gone', async () => {
    const { db, apps } = setup(['shop-1a2b3c', 'wordpress']);
    await db.infrastructure.saveDeploymentInfo(app({ id: 'odoo-p1', name: 'Shop', namespace: 'shop-1a2b3c', appType: 'odoo-project' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress', appType: 'wordpress' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'gone', name: 'Gone', appType: 'wordpress' }));
    expect((await apps.getAll('bo')).map((entry) => entry.id)).toEqual(['odoo-p1', 'wp']);
    expect((await db.infrastructure.getDeployments()).map((entry) => entry.id)).toEqual(['odoo-p1', 'wp']);
  });

  it('tells the owner\'s browsers about an app deleted outside Koala', async () => {
    const { db, apps } = setup([]);
    await db.infrastructure.saveDeploymentInfo(app({ id: 'gone', name: 'Gone' }));
    const io = mock<SocketServer>();
    const room = mock<{ emit: (event: string, payload: unknown) => void }>();
    io.to.calledWith('user:bo').mockReturnValue(room as never);
    await apps.getAll('bo', io);
    expect(room.emit).toHaveBeenCalledWith('resource-destroyed', { id: 'gone', type: 'deployment', name: 'Gone', outOfBand: true });
  });

  it('keeps an app that failed before its namespace was made, so the person still sees it failed', async () => {
    const { db, apps } = setup([]);
    await db.infrastructure.saveDeploymentInfo(app({ id: 'books', name: 'Books', strategy: 'native', appType: 'audiobookshelf', status: 'failed' }));
    expect((await apps.getAll('bo')).map((entry) => [entry.id, entry.status])).toEqual([['books', 'failed']]);
  });

  it('lists only the person\'s own apps', async () => {
    const { db, apps } = setup(['a', 'b']);
    await db.infrastructure.saveDeploymentInfo(app({ id: 'mine', name: 'a' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'theirs', name: 'b', ownerId: 'someone-else' }));
    expect((await apps.getAll('bo')).map((entry) => entry.id)).toEqual(['mine']);
  });

  it('keeps what it knows, and stamps it, when the cluster cannot be read or is still provisioning', async () => {
    const { db, infra, apps } = setup(['wordpress']);
    await db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress' }));
    infra.runKubectl.mockRejectedValue(new Error('cluster unreachable'));
    expect((await apps.getAll('bo')).map((entry) => entry.id)).toEqual(['wp']);
    const still = setup([], [{ ...cluster, status: 'provisioning' }]);
    await still.db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress' }));
    expect((await still.apps.getAll('bo')).map((entry) => entry.id)).toEqual(['wp']);
    expect(still.infra.runKubectl).not.toHaveBeenCalled();
  });

  it('never removes what it did not judge: an app made while it read the cluster, and the apps of a cluster being destroyed', async () => {
    const { db, infra, apps } = setup([]);
    await db.infrastructure.saveCluster({ id: 'leaving', name: 'leaving', provider: 'k3d', status: 'destroying', ownerId: 'bo' });
    infra.runKubectl.mockImplementation(async () => {
      await db.infrastructure.saveDeploymentInfo(app({ id: 'new', name: 'New', status: 'deploying' }));
      return namespaceList(['wordpress']);
    });
    await db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress', appType: 'wordpress' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'gone', name: 'Gone', appType: 'wordpress' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'on-leaving', name: 'OnLeaving', clusterId: 'leaving' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'orphan', name: 'Orphan', clusterId: 'never-was' }));
    await apps.getAll('bo');
    expect((await db.infrastructure.getDeployments()).map((entry) => entry.id).sort()).toEqual(['new', 'on-leaving', 'wp']);
  });
});

describe('discovering what is on a cluster', () => {
  it('does not discover again a release it already tracks under a namespace of its own name', async () => {
    const { db, apps } = setup(['shop-1a2b3c', 'stray']);
    await db.infrastructure.saveDeploymentInfo(app({ id: 'odoo-p1', name: 'Shop', namespace: 'shop-1a2b3c', appType: 'odoo-project' }));
    const found = await apps.discoverDeployments('c1', asPerson('bo'));
    expect(found.map((entry) => entry.name)).toEqual(['stray']);
    expect((await db.infrastructure.getDeployments()).map((entry) => entry.name).sort()).toEqual(['Shop', 'stray']);
  });

  it('skips the platform\'s own namespaces and names an app from its helm chart', async () => {
    const { db, clusters, infra, apps } = setup(['default', 'kube-system', 'jellyfin-ns']);
    await seedAppSpecs(db.infrastructure);
    clusters.isMockCloud.mockReturnValue(false);
    infra.runHelm.mockResolvedValue(JSON.stringify([{ Namespace: 'jellyfin-ns', Chart: 'jellyfin:1.0' }]));
    const found = await apps.discoverDeployments('c1', asPerson('bo'));
    expect(found).toEqual([expect.objectContaining({ name: 'jellyfin-ns', strategy: 'helm', appType: 'jellyfin', status: 'running', ownerId: 'bo' })]);
    expect(infra.runHelm).toHaveBeenCalledWith(['list', '-A', '-o', 'json', '--kube-context', 'k3d-system'], '/tmp/kubeconfig');
  });

  it('names an app from its pods when helm has no release in the namespace or cannot be asked', async () => {
    const { db, infra, apps } = setup(['plain']);
    await seedAppSpecs(db.infrastructure);
    infra.runHelm.mockRejectedValue(new Error('helm: not found'));
    infra.runKubectl.mockImplementation(async (args) => (args.includes('pods') ? namespaceList(['minio-7d9f-abc']) : namespaceList(['plain'])));
    const found = await apps.discoverDeployments('c1', asPerson('bo'));
    expect(found).toEqual([expect.objectContaining({ name: 'plain', strategy: 'native', appType: 'minio' })]);
  });

  it('discovers a namespace without an app type when its pods cannot be listed', async () => {
    const { infra, apps } = setup(['mystery']);
    infra.runHelm.mockResolvedValue('[]');
    infra.runKubectl.mockImplementation(async (args) => { if (args.includes('pods')) throw new Error('forbidden'); return namespaceList(['mystery']); });
    const [entry] = await apps.discoverDeployments('c1', asPerson('bo'));
    expect(entry?.appType).toBeUndefined();
  });

  it('says the cluster is not found when the person may not see everything on it', async () => {
    const { clusters, apps } = setup();
    clusters.getById.mockResolvedValue(undefined);
    await expect(apps.discoverDeployments('c1', asPerson('bo'))).rejects.toThrow('Cluster not found');
  });
});

describe('aborting an app', () => {
  it('stops the workflow that deploys it once a bridge is set, then removes its namespace and record', async () => {
    const { db, infra, apps } = setup(['wordpress']);
    const bridge = mock<Pick<TemporalBridge, 'terminateWorkflow'>>();
    bridge.terminateWorkflow.mockResolvedValue(true);
    apps.setTemporalBridge(bridge);
    infra.getLogPath.mockReturnValue('/tmp/abort.log');
    await db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress', appType: 'wordpress', status: 'deploying', temporalWorkflowId: 'wf-1' }));
    await apps.abort('wp', 'bo');
    await vi.waitFor(async () => expect(await db.infrastructure.getDeployments()).toEqual([]));
    expect(bridge.terminateWorkflow).toHaveBeenCalledWith('wf-1', 'User aborted deployment');
    expect(infra.waitForNamespaceDeletion).toHaveBeenCalledWith('wordpress', '/tmp/kubeconfig');
  });

  it('says the deployment is not found when it is not the person\'s', async () => {
    const { apps } = setup();
    await expect(apps.abort('nope', 'bo')).rejects.toThrow('Deployment not found');
  });
});
