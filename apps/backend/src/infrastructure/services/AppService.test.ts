import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { containing } from '../../platform/lib/test-matchers.js';
import { AppService } from './AppService.js';
import type { BuilderService } from './BuilderService.js';
import type { ClusterService } from './ClusterService.js';
import type { InfrastructureService } from './InfrastructureService.js';
import type { TemporalBridge } from './TemporalBridge.js';
import type { ClusterAccess } from './ClusterAccess.js';

const at = 'then';
const cluster: ClusterMetadata = { id: 'c1', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'bo' };
const namespaceList = (names: string[]): string => JSON.stringify({ items: names.map((name) => ({ metadata: { name } })) });
const app = (over: Partial<DeploymentMetadata> & Pick<DeploymentMetadata, 'id' | 'name'>): DeploymentMetadata => ({ clusterId: 'c1', strategy: 'helm', ownerId: 'bo', status: 'running', createdAt: at, ...over }) as DeploymentMetadata;

function setup(namespaces: string[] = [], clustersSeen: ClusterMetadata[] = [cluster]) {
  const db = memoryDatabase();
  const clusters = mock<ClusterService>();
  clusters.reconcileAllClusters.mockResolvedValue(clustersSeen);
  clusters.getById.mockResolvedValue(cluster);
  clusters.getKubeconfigPath.mockResolvedValue('/tmp/kubeconfig');
  const access = mock<ClusterAccess>();
  access.kubeconfigOf.mockResolvedValue('/tmp/kubeconfig');
  access.kubectl.mockResolvedValue(namespaceList(namespaces));
  Object.assign(clusters, { access });
  clusters.isMockCloud.mockReturnValue(false);
  clusters.getPhysicalClusterName.mockReturnValue(cluster.name);
  const infra = mock<InfrastructureService>();
  infra.runKubectl.mockResolvedValue(namespaceList(namespaces));
  const apps = new AppService(db, infra, clusters, mock<BuilderService>());
  return { db, clusters, infra, apps, access };
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

describe('listing apps', () => {
  it('reads each cluster once as it lists, never drops an app, and says plainly which ones it could not check and why', async () => {
    const { db, apps, access } = setup([]);
    access.kubectl.mockImplementation(async (cluster, args) => {
      expect(args).toEqual(['get', 'namespaces', '-o', 'json']);
      if (cluster === 'c1') return namespaceList(['wordpress', 'shop-1a2b3c']);
      throw new Error('machine-desk is stopped until something runs on it');
    });
    await db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'shop', name: 'Shop', namespace: 'shop-1a2b3c' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'gone', name: 'Gone', namespace: 'gone-4d5e6f' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'tabby', name: 'Tabby', clusterId: 'machine-desk' }));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'theirs', name: 'Theirs', ownerId: 'someone-else' }));

    const listed = await apps.getAll('bo');

    expect(listed.map((entry) => [entry.id, entry.listing])).toEqual([
      ['wp', { checked: true, onCluster: true }],
      ['shop', { checked: true, onCluster: true }],
      ['gone', { checked: true, onCluster: false }],
      ['tabby', { checked: false, why: 'machine-desk is stopped until something runs on it' }],
    ]);
    expect(access.kubectl).toHaveBeenCalledTimes(2);
    expect((await db.infrastructure.getDeployments()).map((entry) => entry.id)).toEqual(['wp', 'shop', 'gone', 'tabby', 'theirs']);
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

  it('keeps the app\'s record, failed with why, when its namespace cannot be removed, rather than deleting it on a guess', async () => {
    const { db, infra, apps } = setup();
    apps.setTemporalBridge(mock<Pick<TemporalBridge, 'terminateWorkflow'>>());
    infra.getLogPath.mockReturnValue('/tmp/abort.log');
    infra.waitForNamespaceDeletion.mockRejectedValue(new Error('the cluster refused: Forbidden'));
    await db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress', appType: 'wordpress' }));
    await apps.abort('wp', 'bo');
    await vi.waitFor(async () => expect((await db.infrastructure.getDeployments())[0]).toMatchObject({ id: 'wp', status: 'failed', healthReason: 'stopping it failed: the cluster refused: Forbidden' }));
  });

  it('will not stop a deploy\'s workflow it was given no bridge for, and says so on the app', async () => {
    const { db, infra, apps } = setup();
    infra.getLogPath.mockReturnValue('/tmp/abort.log');
    await db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress', temporalWorkflowId: 'wf-1' }));
    await apps.abort('wp', 'bo');
    await vi.waitFor(async () => expect((await db.infrastructure.getDeployments())[0]).toMatchObject({ status: 'failed', healthReason: containing('no Temporal bridge') }));
    expect(infra.waitForNamespaceDeletion).not.toHaveBeenCalled();
  });
});

describe('reading an app on its cluster', () => {
  it('reads its pods, Helm status and diagnostics through the cluster\'s one door, by the app\'s cluster', async () => {
    const { db, access, apps } = setup();
    await db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress', appType: 'wordpress' }));
    access.kubectl.mockResolvedValue(JSON.stringify({ items: [{ metadata: { name: 'wp-0' } }] }));
    expect((await apps.listPods('wp', 'bo')).pods).toEqual([{ metadata: { name: 'wp-0' } }]);
    expect(access.kubectl).toHaveBeenCalledWith('c1', ['get', 'pods', '-n', 'wordpress', '-o', 'json']);
    access.helm.mockResolvedValue('STATUS: deployed');
    expect(await apps.getHelmStatus('wp', 'bo')).toBe('STATUS: deployed');
    expect(access.helm).toHaveBeenCalledWith('c1', ['status', 'wordpress', '-n', 'wordpress']);
  });

  it('says the cluster could not be read, rather than answering no pods or a release that is not there', async () => {
    const { db, access, apps } = setup();
    await db.infrastructure.saveDeploymentInfo(app({ id: 'wp', name: 'WordPress', appType: 'wordpress' }));
    access.kubectl.mockRejectedValue(new Error('desk is stopped until something runs on it'));
    access.helm.mockRejectedValue(new Error('desk is stopped until something runs on it'));
    await expect(apps.listPods('wp', 'bo')).rejects.toThrow('desk is stopped');
    await expect(apps.getDiagnostics('wp', 'bo')).rejects.toThrow('desk is stopped');
    await expect(apps.getHelmStatus('wp', 'bo')).rejects.toThrow('desk is stopped');
  });

  it('will not guess an app\'s Helm release when no app type is recorded', async () => {
    const { db, apps } = setup();
    await db.infrastructure.saveDeploymentInfo(app({ id: 'x', name: 'Mystery' }));
    await expect(apps.getHelmStatus('x', 'bo')).rejects.toThrow('Mystery records no app type, so its Helm release cannot be named');
  });
});
