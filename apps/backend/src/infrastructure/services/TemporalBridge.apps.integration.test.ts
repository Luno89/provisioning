import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { TOOLS } from '../testing/real-k3s.js';
import { ClusterAccess } from './ClusterAccess.js';
import { TemporalBridge } from './TemporalBridge.js';
import { testNamespaces } from '../testing/test-namespaces.js';
import { testDataDir } from '../../platform/testing/data-dir.js';

const KEY = 'test-key' as never;
const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const HERE = namespaces.name('here');

afterAll(async () => { await namespaces.removeAll(); }, 0);

describe('checking each app on a real cluster', () => {
  it('marks an app whose namespace is not on its machine unhealthy with why, keeping its record, and leaves one whose namespace is there', async () => {
    const db = await testDatabase();
    const machine = { id: 'machine-apps', name: 'machine-apps', provider: 'machine', machineId: 'apps', status: 'healthy', ownerId: 'u1', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata;
    await db.infrastructure.saveCluster(machine);
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-apps-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
    await access.kubectl('machine-apps', ['create', 'namespace', HERE]);
    const app = (id: string, namespace: string): DeploymentMetadata =>
      ({ id, name: id, namespace, clusterId: 'machine-apps', strategy: 'helm', appType: 'wordpress', ownerId: 'u1', status: 'running', createdAt: 't' }) as DeploymentMetadata;
    await db.infrastructure.saveDeploymentInfo(app('here', HERE));
    await db.infrastructure.saveDeploymentInfo(app('gone', 'gone-4d5e6f'));

    await new TemporalBridge(db, testDataDir(), undefined, KEY, { access } as never).checkApps();

    const byId = Object.fromEntries((await db.infrastructure.getDeployments()).map((dep) => [dep.id, [dep.status, dep.healthReason]]));
    expect(byId).toEqual({ here: ['running', undefined], gone: ['unhealthy', 'its namespace gone-4d5e6f is not on its cluster, so nothing of it runs there; destroy the app or deploy it again'] });
  });
});
