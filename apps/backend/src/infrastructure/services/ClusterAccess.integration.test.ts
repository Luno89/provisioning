import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, inject, it } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { startedMachine } from '../lib/cluster-places.js';
import { TOOLS } from '../testing/real-k3s.js';
import { ClusterAccess, type ClusterAccessDeps } from './ClusterAccess.js';

const KEY = 'test-key' as never;

const k3s = inject('k3s');

const machine = (overrides: Partial<ClusterMetadata>): ClusterMetadata =>
  ({ name: overrides.id, provider: 'machine', status: 'healthy', ownerId: 'owner', createdAt: 't', ...overrides }) as ClusterMetadata;

async function door(records: ClusterMetadata[], overrides: Partial<ClusterAccessDeps> = {}): Promise<ClusterAccess> {
  const db = await testDatabase();
  for (const record of records) await db.infrastructure.saveCluster(record);
  return new ClusterAccess({
    clusters: db.infrastructure,
    here: { koalaMachineId: 'dev1', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-cluster-access-')),
    processes: nodeProcesses,
    streams: nodeStreams,
    tools: TOOLS,
    dataKey: KEY,
    serviceAccount: k3s.account,
    ...overrides,
  });
}

describe('ClusterAccess against a real k3s', () => {
  it('reaches the cluster Koala runs on with nothing but its service account, as a pod does', async () => {
    const access = await door([machine({ id: 'machine-dev1', machineId: 'dev1' })]);
    await access.kubectl('machine-dev1', ['create', 'namespace', 'koala-own']);
    expect(await access.kubectl('machine-dev1', ['get', 'namespace', 'koala-own', '-o', 'name'])).toBe('namespace/koala-own\n');
  });

  it('reaches another machine through the kubeconfig sealed on its record, kubectl and helm alike', async () => {
    const access = await door([machine({ id: 'machine-dev2', machineId: 'dev2', kubeconfigEnc: encryptValue(k3s.admin, KEY) })]);
    const reach = await access.reach('machine-dev2');
    await access.kubectl(reach, ['create', 'configmap', 'shop', '-n', 'default', '--from-literal=a=b']);
    expect(await access.kubectl(reach, ['get', 'configmap', 'shop', '-n', 'default', '-o', 'jsonpath={.data.a}'])).toBe('b');
    expect(await access.helm(reach, ['list', '-A', '-o', 'json'])).toBe('[]\n');
  });

  it('works a machine from the reach a workflow hands over, in a process holding no records and no key', async () => {
    const access = await door([], { clusters: undefined, dataKey: undefined });
    const reach = startedMachine('machine-dev3', k3s.admin);
    await access.apply(reach, 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: from-a-workflow\n');
    expect(await access.kubectl(reach, ['get', 'namespace', 'from-a-workflow', '-o', 'name'])).toBe('namespace/from-a-workflow\n');
  });

  it('applies the same new thing twice at once, the loser of the race applying again', async () => {
    const access = await door([], { clusters: undefined });
    const reach = startedMachine('machine-dev3', k3s.admin);
    const manifest = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: raced\n  namespace: default\ndata:\n  a: b\n';
    await Promise.all([access.apply(reach, manifest), access.apply(reach, manifest), access.apply(reach, manifest)]);
    expect(await access.kubectl(reach, ['get', 'configmap', 'raced', '-n', 'default', '-o', 'jsonpath={.data.a}'])).toBe('b');
  });

  it('pipes a stream into a pod and follows what kubectl prints', async () => {
    const access = await door([], { clusters: undefined });
    const reach = startedMachine('machine-dev3', k3s.admin);
    const manifest = ['apiVersion: v1\n', 'kind: ConfigMap\n', 'metadata:\n  name: piped\n  namespace: default\n', 'data:\n  data: streamed\n'];
    const piped = await access.pipe(reach, ['apply', '-f', '-', '-o', 'name'], Readable.from(manifest));
    expect(piped).toBe('configmap/piped\n');
    let printed = '';
    const followed = await access.follow(reach, ['get', 'configmap', 'piped', '-n', 'default', '-o', 'jsonpath={.data.data}'], (chunk) => { printed += chunk; });
    expect((await followed.ended).code).toBe(0);
    expect(printed).toBe('streamed');
  });

  it('passes on what kubectl said when the cluster refuses', async () => {
    const access = await door([], { clusters: undefined });
    await expect(access.kubectl(startedMachine('machine-dev3', k3s.admin), ['get', 'namespace', 'nowhere'])).rejects.toThrow('namespaces "nowhere" not found');
  });
});
