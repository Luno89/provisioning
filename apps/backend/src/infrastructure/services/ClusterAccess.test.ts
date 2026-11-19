import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { encryptValue, type ClusterMetadata, type Processes, type Streams } from '../../platform/index.js';
import { startedMachine } from '../lib/cluster-places.js';
import { MemoryInfrastructureStore } from '../testing/memory-store.js';
import { ClusterAccess, clusterAccessOfKubeconfig, runnersByRecord, type ClusterAccessDeps } from './ClusterAccess.js';
import { WorkStopped, withWorkFor } from '@koala/engine-core/work-for';
import { theFence } from '../../platform/lib/fence.js';

const spawned = vi.hoisted(() => ({ runs: [] as Array<{ command: string; args: readonly string[] }> }));

vi.mock('../../platform/index.js', async (actual) => ({
  ...(await actual<typeof import('../../platform/index.js')>()),
  nodeProcesses: { run: async (run: { command: string; args: readonly string[] }) => { spawned.runs.push(run); return { code: 0, stdout: 'spawned', stderr: '' }; } },
}));

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
    const { access } = await door({}, [cluster({ status: 'stopped' }), cluster({ id: 'old', name: 'old', provider: 'k3d' as never })]);
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

  it('reads a chart from the repository standing in for every one when CHART_SOURCES is set, and from the pinned one otherwise', async () => {
    const args = ['upgrade', '--install', 'kps', 'kube-prometheus-stack', '--repo', 'https://prometheus-community.github.io/helm-charts', '--version', '91.7.0'];
    const pinned = await door({ clusters: undefined, dataKey: undefined });
    await pinned.access.helm(startedMachine('machine-dev2', ADMIN), args);
    expect(pinned.processes.run).toHaveBeenCalledWith({ command: '/bin/helm', args: ['--kubeconfig', join(pinned.folder, 'kubeconfig-machine-machine-dev2'), ...args], input: undefined });
    const stood = await door({ clusters: undefined, dataKey: undefined, chartSources: 'http://127.0.0.1:4100' });
    await stood.access.helm(startedMachine('machine-dev2', ADMIN), args);
    expect(stood.processes.run).toHaveBeenCalledWith({ command: '/bin/helm', args: ['--kubeconfig', join(stood.folder, 'kubeconfig-machine-machine-dev2'), 'upgrade', '--install', 'kps', 'kube-prometheus-stack', '--repo', 'http://127.0.0.1:4100/prometheus-community.github.io/helm-charts', '--version', '91.7.0'], input: undefined });
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
    streams.follow.mockImplementation((_run, onOutput) => { onOutput('line'); return { pid: undefined, stop: () => {}, ended: Promise.resolve(OK) }; });
    await access.follow(reach, ['logs', '-f', 'app'], (chunk) => seen.push(chunk));
    expect(seen).toEqual(['line']);
  });

  it('passes on what kubectl said when a command fails, and nothing of the command line or where its kubeconfig is', async () => {
    const { access, processes } = await door();
    processes.run.mockResolvedValue({ code: 1, stdout: '', stderr: 'Error from server (NotFound): namespaces "shop" not found\n' });
    const failed = access.kubectl(startedMachine('machine-dev2', ADMIN), ['get', 'ns', 'shop']);
    await expect(failed).rejects.toMatchObject({ name: 'ClusterCommandFailed', clusterId: 'machine-dev2', message: 'Error from server (NotFound): namespaces "shop" not found' });
    processes.run.mockResolvedValue({ code: 137, stdout: '', stderr: '' });
    await expect(access.helm(startedMachine('machine-dev2', ADMIN), ['--namespace', 'shop', 'status', 'shop'])).rejects.toThrow('helm on machine-dev2 exited 137');
  });
});

describe('ClusterAccess: the cluster a chart is applied to', () => {
  it('runs helm and kubectl on the reach it was given, each with its kubeconfig', async () => {
    const { access, processes, folder } = await door({ clusters: undefined, dataKey: undefined });
    const cluster = access.chartCluster(startedMachine('machine-dev2', ADMIN));
    const where = join(folder, 'kubeconfig-machine-machine-dev2');
    expect(await cluster.helm(['status', 'luno', '-n', 'nowrinkles'])).toBe('ok');
    expect(await cluster.kubectl(['get', 'jobs', '-n', 'nowrinkles'])).toBe('ok');
    expect(processes.run.mock.calls.map(([run]) => run)).toEqual([
      { command: '/bin/helm', args: ['--kubeconfig', where, 'status', 'luno', '-n', 'nowrinkles'], input: undefined },
      { command: '/bin/kubectl', args: ['--kubeconfig', where, 'get', 'jobs', '-n', 'nowrinkles'], input: undefined },
    ]);
  });

  it('is a machine reached by the kubeconfig a program was handed, through the repository\'s own kubectl and helm', async () => {
    const { access, target } = clusterAccessOfKubeconfig(ADMIN, 'desk');
    expect(target).toEqual({ clusterId: 'desk', kind: 'machine', kubeconfig: ADMIN });
    spawned.runs = [];
    expect(await access.chartCluster(target).kubectl(['get', 'namespaces'])).toBe('spawned');
    const [run] = spawned.runs;
    expect(run!.command).toMatch(/\/bin\/kubectl$/);
    expect(run!.args.slice(2)).toEqual(['get', 'namespaces']);
    expect(readFileSync(run!.args[1]!, 'utf8')).toBe(ADMIN);
    expect(access.ownId()).toBeUndefined();
  });
});

describe('ClusterAccess: what a workflow is handed', () => {
  it('names the cluster this process runs in, root\'s on root', async () => {
    expect((await door()).access.own()).toEqual({ clusterId: 'machine-dev1', kind: 'koala' });
    expect((await door({ here: { root: true } })).access.own()).toEqual({ clusterId: 'root', kind: 'root' });
  });

  it('hands over a machine as the machine to start, stopped or not, and opens nothing for it', async () => {
    const { access } = await door({ dataKey: undefined }, [cluster({ status: 'stopped' })]);
    expect(await access.handOver('machine-dev2')).toEqual({ clusterId: 'machine-dev2', machine: { deviceId: 'dev2' } });
  });

  it('hands over anything else as its reach, and refuses what cannot be reached with why', async () => {
    const { access } = await door({ here: { root: true }, rootKubeconfig: '/etc/koala/root.yaml' }, [{ id: 'old', name: 'old', provider: 'k3d' as never, status: 'healthy', ownerId: 'owner', createdAt: 't' }]);
    expect(await access.handOver('root')).toEqual({ clusterId: 'root', reach: { clusterId: 'root', kind: 'root' } });
    await expect(access.handOver('old')).rejects.toMatchObject({ name: 'ClusterUnreachable', why: 'other-kind' });
  });
});

describe('ClusterAccess: a kubectl it starts and leaves running', () => {
  it('starts kubectl with the reach\'s kubeconfig and hands back what it started, with what to feed it and where its output goes', async () => {
    const { access, streams, folder } = await door({ clusters: undefined, dataKey: undefined });
    const started = { pid: undefined, stop: () => undefined, ended: Promise.resolve({ code: 3, stdout: '', stderr: 'no such pod' }) };
    streams.start.mockReturnValue(started);
    const output = new PassThrough();
    const io = { input: 'hello', output };
    expect(await access.start(startedMachine('machine-dev2', ADMIN), ['exec', '-i', 'pod', '--', 'cat'], io)).toBe(started);
    expect(streams.start).toHaveBeenCalledWith({ command: '/bin/kubectl', args: ['--kubeconfig', join(folder, 'kubeconfig-machine-machine-dev2'), 'exec', '-i', 'pod', '--', 'cat'], input: undefined }, io);
    expect((await started.ended).code).toBe(3);
  });

  it('starts nothing for a cluster it cannot reach', async () => {
    const { access, streams } = await door({ serviceAccount: undefined });
    await expect(access.start('machine-dev1', ['logs', '-f', 'pod'])).rejects.toMatchObject({ name: 'ClusterUnreachable', why: 'no-account' });
    expect(streams.start).not.toHaveBeenCalled();
  });
});

describe('ClusterAccess: packaging a chart, the one helm call that reaches no cluster', () => {
  it('runs helm package on the chart into the folder it is given, with no kubeconfig', async () => {
    const { access, processes } = await door();
    await access.packageChart('/repo/charts/instance', '/out');
    expect(processes.run).toHaveBeenCalledWith({ command: '/bin/helm', args: ['package', '/repo/charts/instance', '-d', '/out'] });
  });

  it('fails with what helm said when it cannot package the chart', async () => {
    const { access, processes } = await door();
    processes.run.mockResolvedValue({ code: 1, stdout: '', stderr: 'Error: Chart.yaml file is missing' });
    await expect(access.packageChart('/repo/charts/instance', '/out')).rejects.toThrow('Error: Chart.yaml file is missing');
  });
});

describe('ClusterAccess: the cluster a process runs in', () => {
  it('is refused, saying so, in a process that runs in no cluster of its own', async () => {
    expect(() => new ClusterAccess({ here: { root: false }, folder: '/nowhere', processes: mock<Processes>(), streams: mock<Streams>(), tools: { kubectl: 'k', helm: 'h' } }).own())
      .toThrow('this process runs in no cluster of its own');
  });

  it('is refused in a pod that was named neither its machine nor its pool place, whatever account the pod has', () => {
    const account = { host: '10.43.0.1', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' };
    expect(() => new ClusterAccess({ here: { root: false }, folder: '/nowhere', processes: mock<Processes>(), streams: mock<Streams>(), tools: { kubectl: 'k', helm: 'h' }, serviceAccount: account }).own())
      .toThrow('was named neither the machine it runs on (INSTANCE_MACHINE_ID) nor its place on Koala\'s servers (POOL with INSTANCE_NAME)');
  });

  it('is the pool place\'s stand-in cluster in a pool instance', () => {
    const account = { host: '10.43.0.1', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' };
    expect(new ClusterAccess({ here: { poolName: 'bob', root: false }, folder: '/nowhere', processes: mock<Processes>(), streams: mock<Streams>(), tools: { kubectl: 'k', helm: 'h' }, serviceAccount: account }).own())
      .toEqual({ clusterId: 'pool-bob', kind: 'koala' });
  });
});

describe('runnersByRecord: a cluster record\'s kubectl, helm and apply, each by its id', () => {
  it('hands each call to ClusterAccess with the record\'s id and what it was asked', async () => {
    const access = mock<Pick<ClusterAccess, 'kubectl' | 'helm' | 'apply'>>();
    access.kubectl.mockResolvedValue('pods');
    access.helm.mockResolvedValue('[]');
    access.apply.mockResolvedValue('configmap/x created');
    const runners = runnersByRecord(access);
    const record = cluster({});
    expect(await runners.kubectl(record, ['get', 'pods'])).toBe('pods');
    expect(await runners.helm(record, ['list', '-A'])).toBe('[]');
    expect(await runners.apply(record, 'kind: ConfigMap')).toBeUndefined();
    expect(access.kubectl).toHaveBeenCalledWith('machine-dev2', ['get', 'pods']);
    expect(access.helm).toHaveBeenCalledWith('machine-dev2', ['list', '-A']);
    expect(access.apply).toHaveBeenCalledWith('machine-dev2', 'kind: ConfigMap');
  });

  it('fails with ClusterAccess\'s refusal, for a cluster it cannot reach', async () => {
    const { access } = await door({}, [cluster({ status: 'stopped' })]);
    const runners = runnersByRecord(access);
    await expect(runners.kubectl(cluster({}), ['get', 'pods'])).rejects.toThrow('machine-dev2 is stopped until something runs on it');
    await expect(runners.helm(cluster({}), ['list'])).rejects.toThrow('machine-dev2 is stopped until something runs on it');
    await expect(runners.apply(cluster({}), 'kind: ConfigMap')).rejects.toThrow('machine-dev2 is stopped until something runs on it');
  });

  it('runs kubectl and helm on the record\'s kubeconfig through ClusterAccess', async () => {
    const { access, processes, folder } = await door({}, [cluster({ kubeconfigEnc: encryptValue(ADMIN, KEY) })]);
    const runners = runnersByRecord(access);
    await runners.kubectl(cluster({}), ['get', 'pods']);
    await runners.helm(cluster({}), ['list', '-A']);
    expect(processes.run.mock.calls.map(([run]) => [run.command, ...run.args])).toEqual([
      ['/bin/kubectl', '--kubeconfig', join(folder, 'kubeconfig-machine-machine-dev2'), 'get', 'pods'],
      ['/bin/helm', '--kubeconfig', join(folder, 'kubeconfig-machine-machine-dev2'), 'list', '-A'],
    ]);
  });
});

describe('ClusterAccess: nothing reaches a cluster for an account being removed', () => {
  it('runs no kubectl, helm or apply, and starts nothing, for work of an account whose removal has started, and runs everyone else\'s', async () => {
    theFence().close({ kind: 'owner', id: 'leaving-cluster' });
    const { access, processes, streams } = await door({ clusters: undefined, dataKey: undefined });
    const machine = startedMachine('machine-dev2', ADMIN);
    const leaving = <T>(run: () => Promise<T>) => withWorkFor({ owner: 'leaving-cluster' }, run);
    await expect(leaving(() => access.kubectl(machine, ['create', 'namespace', 'koala-run-x']))).rejects.toBeInstanceOf(WorkStopped);
    await expect(leaving(() => access.helm(machine, ['install', 'x', 'chart']))).rejects.toBeInstanceOf(WorkStopped);
    await expect(leaving(() => access.apply(machine, 'kind: Pod'))).rejects.toBeInstanceOf(WorkStopped);
    await expect(leaving(() => access.start(machine, ['exec', 'pod', '--', 'sh']))).rejects.toBeInstanceOf(WorkStopped);
    expect(processes.run).not.toHaveBeenCalled();
    expect(streams.start).not.toHaveBeenCalled();
    expect(await withWorkFor({ owner: 'staying' }, () => access.kubectl(machine, ['get', 'pods']))).toBe('ok');
  });
});
