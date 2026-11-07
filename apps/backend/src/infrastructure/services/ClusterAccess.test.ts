import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { encryptValue, type ClusterMetadata, type Processes, type Streams } from '../../platform/index.js';
import { startedMachine } from '../lib/cluster-places.js';
import { MemoryInfrastructureStore } from '../testing/memory-store.js';
import { ClusterAccess, type ClusterAccessDeps } from './ClusterAccess.js';

const KEY = 'test-key' as never;
const ADMIN = 'apiVersion: v1\nkind: Config\nclusters: []\n';
const OK = { code: 0, stdout: 'ok', stderr: '' };

const cluster = (overrides: Partial<ClusterMetadata>): ClusterMetadata =>
  ({ id: 'machine-dev2', name: 'machine-dev2', provider: 'machine', machineId: 'dev2', status: 'healthy', ownerId: 'owner', createdAt: 't', ...overrides }) as ClusterMetadata;

async function door(overrides: Partial<ClusterAccessDeps> = {}, records: ClusterMetadata[] = []) {
  const store = new MemoryInfrastructureStore();
  for (const record of records) await store.saveCluster(record);
  const processes = mock<Processes>();
  processes.run.mockResolvedValue(OK);
  const streams = mock<Streams>();
  const folder = mkdtempSync(join(tmpdir(), 'koala-cluster-access-'));
  const access = new ClusterAccess({ clusters: store, here: { koalaMachineId: 'dev1', root: false }, folder, processes, streams, tools: { kubectl: '/bin/kubectl', helm: '/bin/helm' }, dataKey: KEY, ...overrides });
  return { access, processes, streams, folder };
}

describe('ClusterAccess: how to reach a cluster, worked out where the records are', () => {
  it('opens a machine\'s sealed kubeconfig into the reach it hands on', async () => {
    const { access } = await door({}, [cluster({ kubeconfigEnc: encryptValue(ADMIN, KEY) })]);
    expect(await access.reach('machine-dev2')).toEqual({ clusterId: 'machine-dev2', kind: 'machine', kubeconfig: ADMIN });
  });

  it('names Koala\'s own cluster, which needs nothing handed on', async () => {
    const { access } = await door({}, [cluster({ id: 'machine-dev1', machineId: 'dev1' })]);
    expect(await access.reach('machine-dev1')).toEqual({ clusterId: 'machine-dev1', kind: 'koala' });
  });

  it('names Koala\'s own cluster by its id in a process that holds no cluster records', async () => {
    const { access } = await door({ clusters: undefined, dataKey: undefined });
    expect(await access.reach('machine-dev1')).toEqual({ clusterId: 'machine-dev1', kind: 'koala' });
  });

  it('refuses, saying why, a stopped machine, another kind of cluster, one it has no record of, and anything without the records or the key', async () => {
    const { access } = await door({}, [cluster({ status: 'stopped' }), cluster({ id: 'old', name: 'old', provider: 'k3d' })]);
    await expect(access.reach('machine-dev2')).rejects.toMatchObject({ name: 'ClusterUnreachable', why: 'stopped', message: 'machine-dev2 is stopped until something runs on it' });
    await expect(access.reach('old')).rejects.toMatchObject({ why: 'other-kind' });
    await expect(access.reach('nowhere')).rejects.toMatchObject({ why: 'unknown' });
    await expect((await door({ clusters: undefined })).access.reach('machine-dev2')).rejects.toMatchObject({ why: 'no-records' });
    await expect((await door({ dataKey: undefined }, [cluster({ kubeconfigEnc: encryptValue(ADMIN, KEY) })])).access.reach('machine-dev2')).rejects.toMatchObject({ why: 'no-key' });
  });
});

describe('ClusterAccess: running kubectl and helm with a reach, wherever it was worked out', () => {
  it('writes a machine\'s kubeconfig where only its owner reads it, and runs kubectl with it', async () => {
    const { access, processes, folder } = await door({ clusters: undefined, dataKey: undefined });
    expect(await access.kubectl(startedMachine('machine-dev2', ADMIN), ['get', 'pods'], 'x')).toBe('ok');
    const where = join(folder, 'kubeconfig-machine-machine-dev2');
    expect(processes.run).toHaveBeenCalledWith({ command: '/bin/kubectl', args: ['--kubeconfig', where, 'get', 'pods'], input: 'x' });
    expect(readFileSync(where, 'utf8')).toBe(ADMIN);
    expect(statSync(where).mode & 0o777).toBe(0o600);
  });

  it('reaches Koala\'s own cluster through its pod\'s account, and refuses in a process outside any pod', async () => {
    const inPod = await door({ serviceAccount: { host: '10.43.0.1', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' } });
    await inPod.access.helm({ clusterId: 'machine-dev1', kind: 'koala' }, ['list', '-A']);
    expect(readFileSync(join(inPod.folder, 'kubeconfig-koala'), 'utf8')).toContain('server: https://10.43.0.1:443');
    const outside = await door();
    await expect(outside.access.kubectl({ clusterId: 'machine-dev1', kind: 'koala' }, ['get', 'ns'])).rejects.toMatchObject({ why: 'no-account' });
  });

  it('reaches root\'s own cluster with the kubeconfig root was given, and refuses when none was', async () => {
    const onRoot = await door({ here: { root: true }, rootKubeconfig: '/etc/koala/root-cluster.yaml' });
    expect(await onRoot.access.kubeconfigOf({ clusterId: 'root', kind: 'root' })).toBe('/etc/koala/root-cluster.yaml');
    await expect((await door({ here: { root: true } })).access.kubeconfigOf('root')).rejects.toMatchObject({ why: 'not-configured' });
  });

  it('works out the reach first when given a cluster\'s id, and runs nothing when it cannot', async () => {
    const { access, processes } = await door({}, [cluster({ status: 'stopped' })]);
    await expect(access.kubectl('machine-dev2', ['get', 'ns'])).rejects.toMatchObject({ why: 'stopped' });
    expect(processes.run).not.toHaveBeenCalled();
  });

  it('applies a manifest once more only when it lost a race to create the same thing', async () => {
    const { access, processes } = await door();
    const reach = startedMachine('machine-dev2', ADMIN);
    processes.run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Error from server (AlreadyExists): error when creating "STDIN": namespaces "shop" already exists' }).mockResolvedValueOnce(OK);
    expect(await access.apply(reach, 'kind: Namespace')).toBe('ok');
    expect(processes.run).toHaveBeenCalledTimes(2);
    processes.run.mockResolvedValue({ code: 1, stdout: '', stderr: 'error: error validating "STDIN"' });
    await expect(access.apply(reach, 'kind: Nonsense')).rejects.toThrow('error validating');
  });

  it('pipes a stream into kubectl and follows its output, each with the same kubeconfig', async () => {
    const { access, streams, folder } = await door();
    const reach = startedMachine('machine-dev2', ADMIN);
    streams.pipe.mockResolvedValue({ code: 0, stdout: 'restored', stderr: '' });
    const input = Readable.from(['dump']);
    expect(await access.pipe(reach, ['exec', '-i', 'db', '--', 'psql'], input)).toBe('restored');
    expect(streams.pipe).toHaveBeenCalledWith({ command: '/bin/kubectl', args: ['--kubeconfig', join(folder, 'kubeconfig-machine-machine-dev2'), 'exec', '-i', 'db', '--', 'psql'], input: undefined }, input);
    streams.pipe.mockResolvedValue({ code: 1, stdout: '', stderr: 'pod db not found' });
    await expect(access.pipe(reach, ['exec'], Readable.from(['x']))).rejects.toThrow('pod db not found');
    const seen: string[] = [];
    streams.follow.mockImplementation((_run, onOutput) => { onOutput('line'); return { stop: () => {}, ended: Promise.resolve(OK) }; });
    await access.follow(reach, ['logs', '-f', 'app'], (chunk) => seen.push(chunk));
    expect(seen).toEqual(['line']);
  });

  it('passes on what kubectl said when a command fails', async () => {
    const { access, processes } = await door();
    processes.run.mockResolvedValue({ code: 1, stdout: '', stderr: 'Error from server (NotFound): namespaces "shop" not found' });
    await expect(access.kubectl(startedMachine('machine-dev2', ADMIN), ['get', 'ns', 'shop'])).rejects.toThrow('namespaces "shop" not found');
  });
});
