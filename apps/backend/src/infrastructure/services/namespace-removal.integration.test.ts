import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it, vi } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { removalHoldOf, removeNamespace } from '../lib/app-namespace.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from './ClusterAccess.js';

const k3s = inject('k3s');
const KEY = 'namespace-key' as never;
const CLUSTER = 'machine-namespaces';

async function onK3s() {
  const db = await testDatabase();
  await db.infrastructure.saveCluster({ id: CLUSTER, name: CLUSTER, provider: 'machine', machineId: 'namespaces', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata);
  const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'elsewhere', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-namespaces-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, dataKey: KEY });
  return { access, kubectl: (...args: string[]) => access.kubectl(CLUSTER, args), remove: (namespace: string) => removeNamespace((args) => access.kubectl(CLUSTER, args), namespace) };
}

describe('removing an app\'s namespace on a real cluster', () => {
  it('returns once the namespace and everything in it are gone', async () => {
    const { kubectl, remove } = await onK3s();
    await kubectl('create', 'namespace', 'leaving-1a2b3c');
    await kubectl('create', 'configmap', 'settings', '-n', 'leaving-1a2b3c', '--from-literal=a=b');
    await remove('leaving-1a2b3c');
    expect(await kubectl('get', 'namespace', 'leaving-1a2b3c', '--ignore-not-found', '-o', 'name')).toBe('');
  });

  it('waits on a finalizer holding the namespace without clearing it, says what holds it, and ends once its controller lets go', async () => {
    const { access, kubectl, remove } = await onK3s();
    await kubectl('create', 'namespace', 'held-4d5e6f');
    await access.apply(CLUSTER, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: held\n  namespace: held-4d5e6f\n  finalizers: [koala.test/hold]\n');
    let ended = false;
    const waiting = remove('held-4d5e6f').then(() => { ended = true; });

    const hold = await vi.waitFor(async () => {
      const found = removalHoldOf(JSON.parse(await kubectl('get', 'namespace', 'held-4d5e6f', '-o', 'json')) as unknown);
      if (!found?.includes('koala.test/hold')) throw new Error(`not held yet: ${found}`);
      return found;
    }, { timeout: 60_000, interval: 500 });
    expect(hold).toMatch(/^it is being removed, and Kubernetes is waiting on: .*koala\.test\/hold/);
    expect(ended).toBe(false);
    expect(await kubectl('get', 'configmap', 'held', '-n', 'held-4d5e6f', '-o', 'jsonpath={.metadata.finalizers}')).toContain('koala.test/hold');

    await kubectl('patch', 'configmap', 'held', '-n', 'held-4d5e6f', '--type=merge', '-p', '{"metadata":{"finalizers":null}}');
    await waiting;
    expect(await kubectl('get', 'namespace', 'held-4d5e6f', '--ignore-not-found', '-o', 'name')).toBe('');
  });
});
