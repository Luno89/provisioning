import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { startedMachine } from '../lib/cluster-places.js';
import { testNamespaces } from '../testing/test-namespaces.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from './ClusterAccess.js';
import { WorkerRestart } from './WorkerRestart.js';

const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const KOALA = namespaces.name('koala-workers');
const reach = startedMachine('machine-dev3', k3s.admin);

const access = new ClusterAccess({
  here: { koalaMachineId: 'dev1', root: false },
  folder: mkdtempSync(join(tmpdir(), 'koala-worker-restart-')),
  processes: nodeProcesses,
  streams: nodeStreams,
  tools: CLUSTER_TOOL_PATHS,
  serviceAccount: k3s.account,
});

const pod = (name: string): string => JSON.stringify({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name, namespace: KOALA },
  spec: { terminationGracePeriodSeconds: 1, containers: [{ name: 'worker', image: 'busybox:1.36', command: ['sleep', '600'] }] },
});

beforeAll(async () => {
  await access.kubectl(reach, ['create', 'namespace', KOALA]);
});
afterAll(async () => { await namespaces.removeAll(); }, 0);

describe('restarting a worker that stopped answering', () => {
  it('deletes its pod the ordinary way and says restarted only once Kubernetes reports the pod gone', async () => {
    await access.apply(reach, pod('worker-engine-frozen'));
    const restart = new WorkerRestart({ access, target: () => reach, namespace: KOALA });
    expect(await restart.restart('worker-engine-frozen')).toBe('restarted');
    await expect(access.kubectl(reach, ['get', 'pod', 'worker-engine-frozen', '-n', KOALA])).rejects.toThrow(/NotFound|not found/);
  });

  it('says a worker that is no pod here is not here, and deletes nothing', async () => {
    const restart = new WorkerRestart({ access, target: () => reach, namespace: KOALA });
    expect(await restart.restart('12345@koala-dev-laptop')).toBe('not-here');
  });
});
