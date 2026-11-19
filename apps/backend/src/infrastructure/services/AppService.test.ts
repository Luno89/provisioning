import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { AppService } from './AppService.js';
import type { BuilderService } from './BuilderService.js';
import type { ClusterService } from './ClusterService.js';
import type { InfrastructureService } from './InfrastructureService.js';
import type { ClusterAccess } from './ClusterAccess.js';
import type { Server as SocketServer } from 'socket.io';

const at = 'then';
const cluster: ClusterMetadata = { id: 'c1', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'bo' };
const toldTo = (told: string[]): SocketServer => ({ to: (room: string) => ({ emit: (event: string) => { told.push(`${room} ${event}`); return true; } }) }) as unknown as SocketServer;
const namespaceList = (names: string[]): string => JSON.stringify({ items: names.map((name) => ({ metadata: { name } })) });
const app = (over: Partial<DeploymentMetadata> & Pick<DeploymentMetadata, 'id' | 'name'>): DeploymentMetadata => ({ clusterId: 'c1', strategy: 'helm', ownerId: 'bo', status: 'running', createdAt: at, ...over }) as DeploymentMetadata;

function setup(namespaces: string[] = []) {
  const db = memoryDatabase();
  const clusters = mock<ClusterService>();
  clusters.getById.mockResolvedValue(cluster);
  const access = mock<ClusterAccess>();
  access.kubeconfigOf.mockResolvedValue('/tmp/kubeconfig');
  access.kubectl.mockResolvedValue(namespaceList(namespaces));
  Object.assign(clusters, { access });
  const infra = mock<InfrastructureService>();
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
    access.kubectl.mockImplementation(async (_cluster, args) => (args[1] === 'pods' ? 'wp-0   1/1   Running' : 'Scheduled   pod/wp-0'));
    expect(await apps.getDiagnostics('wp', 'bo')).toBe('--- POD STATUS (Namespace: wordpress) ---\nwp-0   1/1   Running\n\n--- RECENT EVENTS ---\nScheduled   pod/wp-0');
  });

  it('shows a Palworld server\'s passwords from its Secret on the app\'s cluster, and nothing to anyone else', async () => {
    const { db, access, apps } = setup();
    await db.infrastructure.saveDeploymentInfo(app({ id: 'pal', name: 'World', appType: 'palworld', namespace: 'world-1a2b3c' }));
    access.kubectl.mockResolvedValue(JSON.stringify({ ADMIN_PASSWORD: Buffer.from('castle-key').toString('base64') }));
    expect(await apps.signIns('pal', 'bo')).toEqual([{ describe: 'The in-game admin password (/AdminPassword)', password: 'castle-key' }]);
    expect(access.kubectl).toHaveBeenCalledWith('c1', ['get', 'secret', 'palworld-secrets', '-n', 'world-1a2b3c', '-o', 'jsonpath={.data}', '--ignore-not-found']);
    expect(await apps.signIns('pal', 'someone-else')).toBeUndefined();
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

describe('updating an Odoo app\'s modules', () => {
  const odoo = app({ id: 'd1', name: 'shop', appType: 'odoo', deploymentId: 'shop1a2b', namespace: 'shop-1a2b3c', webRepo: 'library/odoo', webTag: '18.0', dbRepo: 'library/postgres', dbTag: '16' });

  it('builds the modules on the image the app records and applies them to the app\'s own stack', async () => {
    const { db, infra, apps } = setup();
    const builder = mock<BuilderService>();
    builder.buildCustomImage.mockResolvedValue('registry/shop:mods');
    const updating = new AppService(db, infra, (apps as unknown as { clusters: ClusterService }).clusters, builder);
    const applied = new Promise<unknown[]>((settle) => { infra.deploy.mockImplementation(async (...args: unknown[]) => { settle(args); return { stdout: '', logFile: '' }; }); });
    await db.infrastructure.saveDeploymentInfo(odoo);
    const told: string[] = [];
    await updating.updateModules('d1', ['sale'], 'bo', toldTo(told));
    expect(told).toContain('user:bo deployment-updated');
    const [stack, options] = await applied as [string, { env: Record<string, string> }];
    expect(stack).toBe('app-desk-shop1a2b');
    expect(options.env).toMatchObject({ DEPLOYMENT_ID: 'shop1a2b', APP_TYPE: 'odoo', DB_IMAGE_TAG: '16' });
    expect(builder.buildCustomImage).toHaveBeenCalledWith('library/odoo:18.0', ['sale'], 'odoo', expect.anything());
  });

  it('refuses an app recorded without its stack id, changing nothing', async () => {
    const { db, infra, apps } = setup();
    const { deploymentId: _stack, ...unrecorded } = odoo;
    await db.infrastructure.saveDeploymentInfo(unrecorded as DeploymentMetadata);
    await expect(apps.updateModules('d1', ['sale'], 'bo', toldTo([]))).rejects.toThrow('cannot be destroyed, resized or changed through Koala');
    expect((await apps.getById('d1', 'bo'))?.status).toBe('running');
    expect(infra.deploy).not.toHaveBeenCalled();
  });

  it('refuses an app that records no image to build its modules on, rather than guessing one', async () => {
    const { db, infra, apps } = setup();
    const { webTag: _tag, ...untagged } = odoo;
    await db.infrastructure.saveDeploymentInfo(untagged as DeploymentMetadata);
    await expect(apps.updateModules('d1', ['sale'], 'bo', toldTo([]))).rejects.toThrow('shop records no image to build its modules on');
    expect((await apps.getById('d1', 'bo'))?.status).toBe('running');
    expect(infra.deploy).not.toHaveBeenCalled();
  });
});
