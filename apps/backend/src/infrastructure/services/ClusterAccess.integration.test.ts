import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { encryptValue, nodeProcesses, nodeStreams, type ClusterMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { startedMachine } from '../lib/cluster-places.js';
import { TOOLS } from '../testing/real-k3s.js';
import { testNamespaces } from '../testing/test-namespaces.js';
import { ClusterAccess, type ClusterAccessDeps } from './ClusterAccess.js';
import { WorkStopped, withWorkFor } from '@koala/engine-core/work-for';
import { theFence } from '../../platform/index.js';

const KEY = 'test-key' as never;

const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
const OWN = namespaces.name('koala-own');
const FROM_A_WORKFLOW = namespaces.name('from-a-workflow');
const PLAYGROUND = namespaces.name('cluster-access');
const LATE = namespaces.name('late-workspace');

beforeAll(async () => {
  await (await door([], { clusters: undefined })).kubectl(startedMachine('machine-dev3', k3s.admin), ['create', 'namespace', PLAYGROUND]);
});
afterAll(async () => { await namespaces.removeAll(); }, 0);

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
  it('makes no workspace for a step of an account whose removal has started, and makes one for anyone else', async () => {
    const access = await door([], { clusters: undefined });
    const reach = startedMachine('machine-dev3', k3s.admin);
    theFence().close({ kind: 'owner', id: 'leaving-k3s' });
    await expect(withWorkFor({ owner: 'leaving-k3s' }, () => access.kubectl(reach, ['create', 'namespace', LATE]))).rejects.toBeInstanceOf(WorkStopped);
    await expect(access.kubectl(reach, ['get', 'namespace', LATE])).rejects.toMatchObject({ name: 'ClusterCommandFailed' });
    await withWorkFor({ owner: 'staying-k3s' }, () => access.kubectl(reach, ['create', 'namespace', LATE]));
    expect(await access.kubectl(reach, ['get', 'namespace', LATE, '-o', 'name'])).toBe(`namespace/${LATE}\n`);
  });

  it('reaches the cluster Koala runs on with nothing but its service account, as a pod does', async () => {
    const access = await door([machine({ id: 'machine-dev1', machineId: 'dev1' })]);
    await access.kubectl('machine-dev1', ['create', 'namespace', OWN]);
    expect(await access.kubectl('machine-dev1', ['get', 'namespace', OWN, '-o', 'name'])).toBe(`namespace/${OWN}\n`);
  });

  it('reaches another machine through the kubeconfig sealed on its record, kubectl and helm alike', async () => {
    const access = await door([machine({ id: 'machine-dev2', machineId: 'dev2', kubeconfigEnc: encryptValue(k3s.admin, KEY) })]);
    const reach = await access.reach('machine-dev2');
    await access.kubectl(reach, ['create', 'configmap', 'shop', '-n', PLAYGROUND, '--from-literal=a=b']);
    expect(await access.kubectl(reach, ['get', 'configmap', 'shop', '-n', PLAYGROUND, '-o', 'jsonpath={.data.a}'])).toBe('b');
    const quiet = `helm-own-${Math.random().toString(36).slice(2, 8)}`;
    expect(await access.helm(reach, ['list', '-n', quiet, '-o', 'json'])).toBe('[]\n');
  });

  it('works a machine from the reach a workflow hands over, in a process holding no records and no key', async () => {
    const access = await door([], { clusters: undefined, dataKey: undefined });
    const reach = startedMachine('machine-dev3', k3s.admin);
    await access.apply(reach, `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${FROM_A_WORKFLOW}\n`);
    expect(await access.kubectl(reach, ['get', 'namespace', FROM_A_WORKFLOW, '-o', 'name'])).toBe(`namespace/${FROM_A_WORKFLOW}\n`);
  });

  it('applies the same new thing twice at once, the loser of the race applying again', async () => {
    const access = await door([], { clusters: undefined });
    const reach = startedMachine('machine-dev3', k3s.admin);
    const manifest = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: raced\n  namespace: ${PLAYGROUND}\ndata:\n  a: b\n`;
    await Promise.all([access.apply(reach, manifest), access.apply(reach, manifest), access.apply(reach, manifest)]);
    expect(await access.kubectl(reach, ['get', 'configmap', 'raced', '-n', PLAYGROUND, '-o', 'jsonpath={.data.a}'])).toBe('b');
  });

  it('applies server-side what is too big to apply as kubectl keeps it client-side, as a chart\'s CRDs are', async () => {
    const access = await door([], { clusters: undefined });
    const reach = startedMachine('machine-dev3', k3s.admin);
    const manifest = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: large\n  namespace: ${PLAYGROUND}\ndata:\n  big: ${'x'.repeat(300_000)}\n`;
    await expect(access.apply(reach, manifest)).rejects.toThrow(/Too long|too long/);
    await access.apply(reach, manifest, { serverSide: true });
    expect(await access.kubectl(reach, ['get', 'configmap', 'large', '-n', PLAYGROUND, '-o', 'jsonpath={.metadata.managedFields[0].operation}'])).toBe('Apply');
  });

  it('pipes a stream into a pod and follows what kubectl prints', async () => {
    const access = await door([], { clusters: undefined });
    const reach = startedMachine('machine-dev3', k3s.admin);
    const manifest = ['apiVersion: v1\n', 'kind: ConfigMap\n', `metadata:\n  name: piped\n  namespace: ${PLAYGROUND}\n`, 'data:\n  data: streamed\n'];
    const piped = await access.pipe(reach, ['apply', '-f', '-', '-o', 'name'], Readable.from(manifest));
    expect(piped).toBe('configmap/piped\n');
    let printed = '';
    const followed = await access.follow(reach, ['get', 'configmap', 'piped', '-n', PLAYGROUND, '-o', 'jsonpath={.data.data}'], (chunk) => { printed += chunk; });
    expect((await followed.ended).code).toBe(0);
    expect(printed).toBe('streamed');
  });

  it('passes on what kubectl said when the cluster refuses', async () => {
    const access = await door([], { clusters: undefined });
    await expect(access.kubectl(startedMachine('machine-dev3', k3s.admin), ['get', 'namespace', 'nowhere'])).rejects.toThrow('namespaces "nowhere" not found');
  });

  it('starts kubectl, feeding it and sending its output where it is told, and hands back how it ended without throwing', async () => {
    const access = await door([], { clusters: undefined });
    const reach = startedMachine('machine-dev3', k3s.admin);
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => { written += chunk.toString(); });
    const applied = await access.start(reach, ['apply', '-f', '-', '-o', 'name'], { input: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: started\n  namespace: ${PLAYGROUND}\n`, output });
    const ended = await applied.ended;
    expect(ended.code).toBe(0);
    expect(ended.stdout).toBe('');
    expect(written).toBe('configmap/started\n');
    const refused = await (await access.start(reach, ['get', 'namespace', 'nowhere'])).ended;
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('namespaces "nowhere" not found');
  });

  it('stops a kubectl it started that would run until stopped', async () => {
    const access = await door([], { clusters: undefined });
    const watching = await access.start(startedMachine('machine-dev3', k3s.admin), ['get', 'configmaps', '-n', PLAYGROUND, '-w']);
    watching.stop();
    expect((await watching.ended).code).not.toBe(0);
  });
});
