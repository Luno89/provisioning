import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, inject } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { TOOLS } from '../testing/real-k3s.js';
import { AppService } from './AppService.js';
import { ClusterAccess } from './ClusterAccess.js';

const KEY = 'test-key' as never;
const k3s = inject('k3s');

describe('listing apps', () => {
  it('reads each real cluster as it lists, keeps every app, and marks the ones on a stopped machine as not checked with why', async () => {
    const db = await testDatabase();
    const machine = (id: string, status: ClusterMetadata['status']): ClusterMetadata =>
      ({ id, name: id, provider: 'machine', machineId: id, status, ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) }) as ClusterMetadata;
    await db.infrastructure.saveCluster(machine('machine-list', 'healthy'));
    await db.infrastructure.saveCluster(machine('machine-resting', 'stopped'));
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-list-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
    await access.kubectl('machine-list', ['create', 'namespace', 'listed-1a2b3c']);
    const app = (id: string, clusterId: string, namespace: string, ownerId = 'bo'): DeploymentMetadata =>
      ({ id, name: id, namespace, clusterId, strategy: 'helm', appType: 'wordpress', ownerId, status: 'running', createdAt: 't' }) as DeploymentMetadata;
    await db.infrastructure.saveDeploymentInfo(app('here', 'machine-list', 'listed-1a2b3c'));
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
