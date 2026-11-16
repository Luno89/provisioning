import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect, inject } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { TOOLS } from '../testing/real-k3s.js';
import { AppService } from './AppService.js';
import { ClusterAccess } from './ClusterAccess.js';
import { testNamespaces } from '../testing/test-namespaces.js';

const KEY = 'test-key' as never;
const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const LISTED = namespaces.name('listed');

afterAll(async () => { await namespaces.removeAll(); }, 0);

describe('listing apps', () => {
  it('reads each real cluster as it lists, keeps every app, and marks the ones on a stopped machine as not checked with why', async () => {
    const db = await testDatabase();
    const machine = (id: string, status: ClusterMetadata['status']): ClusterMetadata =>
      ({ id, name: id, provider: 'machine', machineId: id, status, ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) }) as ClusterMetadata;
    await db.infrastructure.saveCluster(machine('machine-list', 'healthy'));
    await db.infrastructure.saveCluster(machine('machine-resting', 'stopped'));
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-list-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
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

describe('aborting an app', () => {
  it('removes its namespace from the real cluster and its record, and the model it would have served is nobody\'s default any more', async () => {
    const db = await testDatabase();
    const aborted = namespaces.name('aborted');
    await db.infrastructure.saveCluster({ id: 'machine-abort', name: 'machine-abort', provider: 'machine', machineId: 'machine-abort', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata);
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-abort-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
    await access.kubectl('machine-abort', ['create', 'namespace', aborted]);
    await db.infrastructure.saveDeploymentInfo({ id: 'model', name: 'model', namespace: aborted, clusterId: 'machine-abort', strategy: 'native', appType: 'vllm', ownerId: 'bo', status: 'deploying', createdAt: 't' } as DeploymentMetadata);
    await db.accounts.saveUser({ id: 'bo', email: 'bo@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 't', defaultModelId: 'model' });
    const apps = new AppService(db, { getLogPath: (name: string) => join(tmpdir(), `${name}.log`) } as never, { access } as never, {} as never);

    await apps.abort('model', 'bo');

    await expect.poll(async () => (await db.accounts.getUserById('bo'))?.defaultModelId, { timeout: 60_000 }).toBeUndefined();
    expect(await db.infrastructure.getDeployments()).toEqual([]);
    expect(await access.kubectl('machine-abort', ['get', 'namespace', aborted, '--ignore-not-found', '-o', 'name'])).toBe('');
  }, 90_000);
});
