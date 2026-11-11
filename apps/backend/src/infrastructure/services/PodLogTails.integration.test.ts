import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { TOOLS } from '../testing/real-k3s.js';
import { ClusterAccess } from './ClusterAccess.js';
import { PodLogTails } from './PodLogTails.js';
import { testNamespaces } from '../testing/test-namespaces.js';

const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const NAMESPACE = namespaces.name('shop');

afterAll(async () => { await namespaces.removeAll(); }, 0);
const KEY = 'pod-logs-key' as never;
const CLUSTER = 'machine-logs';

let access: ClusterAccess;

beforeAll(async () => {
  const db = await testDatabase();
  await db.infrastructure.saveCluster({ id: CLUSTER, name: CLUSTER, provider: 'machine', machineId: 'logs', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata);
  await db.infrastructure.saveCluster({ id: 'machine-resting', name: 'machine-resting', provider: 'machine', machineId: 'resting', status: 'stopped', ownerId: 'bo', createdAt: 't' } as ClusterMetadata);
  access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'elsewhere', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-pod-logs-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
  await access.kubectl(CLUSTER, ['create', 'namespace', NAMESPACE]);
  await access.kubectl(CLUSTER, ['run', 'shop-0', '-n', NAMESPACE, '--image=busybox:1.37', '--restart=Never', '--command', '--', 'sh', '-c', 'echo first; while true; do echo tick; sleep 1; done']);
  await access.kubectl(CLUSTER, ['wait', 'pod/shop-0', '-n', NAMESPACE, '--for=condition=Ready', '--timeout=720h']);
}, 300_000);

describe('following a pod\'s logs on a real cluster', () => {
  it('says what the pod prints in the app\'s room as it prints it, until it is stopped', async () => {
    const said: string[] = [];
    const tails = new PodLogTails({ access, say: (room, text) => said.push(`${room}: ${text}`), log: () => undefined });
    await tails.tail({ resourceId: 'shop', clusterId: CLUSTER, namespace: NAMESPACE, podName: 'shop-0' });
    await vi.waitFor(() => {
      const text = said.join('');
      if (!text.includes('first') || (text.match(/tick/g) ?? []).length < 2) throw new Error(`not yet: ${text}`);
    }, { timeout: 60_000, interval: 200 });
    expect(said.every((line) => line.startsWith('shop-kube: '))).toBe(true);
    tails.stop('shop');
    expect(tails.following('shop')).toBe(false);
    const heard = said.length;
    await new Promise((done) => setTimeout(done, 2_500));
    expect(said).toHaveLength(heard);
  }, 120_000);

  it('says kubectl\'s own words when the pod is not there', async () => {
    const said: string[] = [];
    const tails = new PodLogTails({ access, say: (_room, text) => said.push(text), log: () => undefined });
    await tails.tail({ resourceId: 'gone', clusterId: CLUSTER, namespace: NAMESPACE, podName: 'gone-0' });
    await vi.waitFor(() => { if (!tails.following('gone') && said.length) return; throw new Error('still following'); }, { timeout: 60_000, interval: 200 });
    expect(said).toEqual([expect.stringContaining('pods "gone-0" not found')]);
  }, 120_000);

  it('says why when the app\'s cluster is stopped, starting nothing', async () => {
    const said: string[] = [];
    const tails = new PodLogTails({ access, say: (_room, text) => said.push(text), log: () => undefined });
    await expect(tails.tail({ resourceId: 'resting', clusterId: 'machine-resting', namespace: NAMESPACE, podName: 'shop-0' })).rejects.toThrow('machine-resting is stopped until something runs on it');
    expect(said).toEqual(['the logs of shop-0 could not be followed: machine-resting is stopped until something runs on it']);
  });
});
