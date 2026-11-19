import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect, inject } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, succeeded, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { objectWith } from '../../platform/lib/test-matchers.js';
import { PALWORLD_SECRET } from '../lib/app-sign-in.js';
import type { Server as SocketServer } from 'socket.io';
import { testDatabase } from '../../platform/lib/test-database.js';
import { TOOLS } from '../testing/real-k3s.js';
import { AppService } from './AppService.js';
import { ClusterAccess } from './ClusterAccess.js';
import { testNamespaces } from '../testing/test-namespaces.js';

const KEY = 'test-key' as never;
const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const LISTED = namespaces.name('listed');
const WORLD = namespaces.name('world');
const SHOP = namespaces.name('shop');

const machine = (id: string, status: ClusterMetadata['status']): ClusterMetadata =>
  ({ id, name: id, provider: 'machine', machineId: id, status, ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) }) as ClusterMetadata;
const accessOver = (db: Awaited<ReturnType<typeof testDatabase>>): ClusterAccess =>
  new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-apps-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });

afterAll(async () => { await namespaces.removeAll(); }, 0);

describe('listing apps', () => {
  it('reads each real cluster as it lists, keeps every app, and marks the ones on a stopped machine as not checked with why', async () => {
    const db = await testDatabase();
    await db.infrastructure.saveCluster(machine('machine-list', 'healthy'));
    await db.infrastructure.saveCluster(machine('machine-resting', 'stopped'));
    const access = accessOver(db);
    await access.kubectl('machine-list', ['create', 'namespace', LISTED]);
    const app = (id: string, clusterId: string, namespace: string, ownerId = 'bo'): DeploymentMetadata =>
      ({ id, name: id, namespace, clusterId, strategy: 'helm', appType: 'wordpress', ownerId, status: 'running', createdAt: 't' }) as DeploymentMetadata;
    await db.infrastructure.saveDeploymentInfo(app('here', 'machine-list', LISTED));
    await db.infrastructure.saveDeploymentInfo(app('gone', 'machine-list', 'gone-4d5e6f'));
    await db.infrastructure.saveDeploymentInfo(app('resting', 'machine-resting', 'resting-7a8b9c'));
    await db.infrastructure.saveDeploymentInfo(app('theirs', 'machine-list', 'theirs-1a2b3c', 'someone-else'));

    const listed = await new AppService(db, {} as never, { access } as never, {} as never).getAll('bo');

    expect(Object.fromEntries(listed.map((entry) => [entry.id, entry.listing]))).toEqual({
      here: { checked: true, onCluster: true },
      gone: { checked: true, onCluster: false },
      resting: { checked: false, why: 'machine-resting is stopped until something runs on it' },
    });
    expect((await db.infrastructure.getDeployments()).map((entry) => entry.id).sort()).toEqual(['gone', 'here', 'resting', 'theirs']);
  });
});


describe('reading an app on its machine', () => {
  it('shows a real app\'s pods, Helm release, diagnostics and the sign-ins kept in its Secret, only to its owner', async () => {
    const db = await testDatabase();
    await db.infrastructure.saveCluster(machine('machine-world', 'healthy'));
    const access = accessOver(db);
    const on = (args: string[]) => access.kubectl('machine-world', args);
    await on(['create', 'namespace', WORLD]);
    await on(['create', 'deployment', 'palworld', '-n', WORLD, '--image=registry.k8s.io/pause:3.9']);
    await on(['rollout', 'status', 'deployment/palworld', '-n', WORLD, '--timeout=720h']);
    await on(['create', 'secret', 'generic', PALWORLD_SECRET, '-n', WORLD, '--from-literal=ADMIN_PASSWORD=castle-key', '--from-literal=SERVER_PASSWORD=join-me']);
    const chart = mkdtempSync(join(tmpdir(), 'koala-apps-chart-'));
    mkdirSync(join(chart, 'templates'));
    writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: palworld\nversion: 0.1.0\n');
    writeFileSync(join(chart, 'templates', 'note.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: palworld-note\ndata:\n  said: hello\n');
    await access.helm('machine-world', ['install', 'palworld', chart, '-n', WORLD, '--wait']);
    await db.infrastructure.saveDeploymentInfo({ id: 'world', name: 'World', namespace: WORLD, clusterId: 'machine-world', strategy: 'helm', appType: 'palworld', ownerId: 'bo', status: 'running', createdAt: 't' } as DeploymentMetadata);
    const apps = new AppService(db, {} as never, { access } as never, {} as never);

    expect(await apps.listPods('world', 'bo')).toEqual({ namespace: WORLD, pods: [objectWith({ metadata: objectWith({ labels: objectWith({ app: 'palworld' }) }) })] });
    expect(await apps.getHelmStatus('world', 'bo')).toMatch(/STATUS: deployed/);
    const diagnostics = await apps.getDiagnostics('world', 'bo');
    expect(diagnostics).toContain(`--- POD STATUS (Namespace: ${WORLD}) ---`);
    expect(diagnostics).toMatch(/palworld-\S+\s+1\/1\s+Running/);
    expect(diagnostics.split('--- RECENT EVENTS ---')[1]).toMatch(/Scheduled/);
    expect(await apps.signIns('world', 'bo')).toEqual([
      { describe: 'The in-game admin password (/AdminPassword)', password: 'castle-key' },
      { describe: 'The password players join with', password: 'join-me' },
    ]);
    expect(await apps.signIns('world', 'someone-else')).toBeUndefined();
    await expect(apps.listPods('world', 'someone-else')).rejects.toThrow('Deployment not found');
  });
});

describe('updating an Odoo app\'s modules', () => {
  it('applies the modules with the kubeconfig of the machine the app is on', async () => {
    const db = await testDatabase();
    const cluster = machine('machine-shop', 'healthy');
    await db.infrastructure.saveCluster(cluster);
    const access = accessOver(db);
    await access.kubectl(cluster.id, ['create', 'namespace', SHOP]);
    await db.infrastructure.saveDeploymentInfo({ id: 'shop', name: 'shop', namespace: SHOP, clusterId: cluster.id, strategy: 'helm', appType: 'odoo', deploymentId: 'shop1a2b', webRepo: 'library/odoo', webTag: '18.0', dbRepo: 'library/postgres', dbTag: '16', ownerId: 'bo', status: 'running', createdAt: 't' } as DeploymentMetadata);
    const applied = Promise.withResolvers<Record<string, string>>();
    const infra = { getLogPath: (name: string) => join(tmpdir(), `${name}.log`), deploy: async (_stack: string, options: { env: Record<string, string> }) => { applied.resolve(options.env); return { stdout: '', logFile: '' }; } };
    const builder = { buildCustomImage: async () => 'registry/shop:mods' };
    const io = { to: () => ({ emit: () => true }) } as unknown as SocketServer;
    const apps = new AppService(db, infra as never, { access, getById: async () => cluster } as never, builder as never);

    await apps.updateModules('shop', ['sale'], 'bo', io);
    const env = await applied.promise;

    expect(env).toMatchObject({ CLUSTER_NAME: 'machine-shop', DEPLOYMENT_ID: 'shop1a2b', WEB_IMAGE_TAG: 'mods' });
    expect((await succeeded(nodeProcesses, { command: TOOLS.kubectl, args: ['--kubeconfig', env.KUBECONFIG!, 'get', 'namespace', SHOP, '-o', 'name'] })).trim()).toBe(`namespace/${SHOP}`);
  });
});
