import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { decryptValue, nodeProcesses, nodeStreams, theFence, writePrivate, type Followed, type Io, type PlatformRole, type ProcessResult, type ProcessRun, type Processes, type SecretKey, type Streams, type ClusterSettings } from '../../platform/index.js';
import { lostCreateRace } from '../lib/apply-races.js';
import { machineToStart, ownReach, placeOf, serviceAccountKubeconfig, type HandOver, type Here, type Reach, type ServiceAccount, type WhyUnreachable } from '../lib/cluster-places.js';
import type { InfrastructureStore } from '../store.js';

export class ClusterUnreachable extends Error {
  constructor(readonly clusterId: string, readonly why: WhyUnreachable, message: string) {
    super(message);
    this.name = 'ClusterUnreachable';
  }
}

export class ClusterCommandFailed extends Error {
  constructor(readonly clusterId: string, readonly run: ProcessRun, readonly result: ProcessResult) {
    super(result.stderr.trim() || result.stdout.trim() || `${basename(run.command)} on ${clusterId} exited ${result.code}`);
    this.name = 'ClusterCommandFailed';
  }
}

export interface ClusterAccessDeps {
  here: Here;
  folder: string;
  processes: Processes;
  streams: Streams;
  tools: { kubectl: string; helm: string };
  clusters?: Pick<InfrastructureStore, 'getClusters'> | undefined;
  dataKey?: SecretKey | undefined;
  serviceAccount?: ServiceAccount | undefined;
  rootKubeconfig?: string | undefined;
}

export type Target = Reach | string;

const clusterIdOf = (target: Target): string => (typeof target === 'string' ? target : target.clusterId);

export class ClusterAccess {
  constructor(private readonly deps: ClusterAccessDeps) {}

  get here(): Here {
    return this.deps.here;
  }

  ownId(): string | undefined {
    return ownReach(this.deps.here)?.clusterId;
  }

  own(): Reach {
    const reach = ownReach(this.deps.here);
    if (!reach) throw new ClusterUnreachable('own', 'no-account', 'this process runs in no cluster of its own: it is not root and was named neither the machine it runs on (INSTANCE_MACHINE_ID) nor its place on Koala\'s servers (POOL with INSTANCE_NAME)');
    return reach;
  }

  async handOver(clusterId: string): Promise<HandOver> {
    const machine = machineToStart(clusterId, await this.record(clusterId), this.deps.here);
    return machine ? { clusterId, machine } : { clusterId, reach: await this.reach(clusterId) };
  }

  private async record(clusterId: string) {
    return this.deps.clusters ? (await this.deps.clusters.getClusters()).find((cluster) => cluster.id === clusterId) : undefined;
  }

  async reach(clusterId: string): Promise<Reach> {
    const record = await this.record(clusterId);
    const place = placeOf(clusterId, record, this.deps.here);
    if (place.kind === 'unreachable' && place.why === 'unknown' && !this.deps.clusters) throw new ClusterUnreachable(clusterId, 'no-records', 'this process holds no cluster records; the workflow that sent the work hands over how to reach the cluster');
    switch (place.kind) {
      case 'unreachable':
        throw new ClusterUnreachable(clusterId, place.why, place.reason);
      case 'koala':
        return { clusterId, kind: 'koala' };
      case 'root':
        return { clusterId, kind: 'root' };
      case 'machine':
        if (!this.deps.dataKey) throw new ClusterUnreachable(clusterId, 'no-key', 'this process holds no data key, so it cannot open a machine\'s kubeconfig');
        return { clusterId, kind: 'machine', kubeconfig: decryptValue(place.sealed, this.deps.dataKey) };
    }
  }

  async kubeconfigOf(target: Target): Promise<string> {
    const reach = typeof target === 'string' ? await this.reach(target) : target;
    switch (reach.kind) {
      case 'koala':
        if (!this.deps.serviceAccount) throw new ClusterUnreachable(reach.clusterId, 'no-account', 'this process is not running inside Koala\'s cluster, so it has no account there to reach it with');
        return this.written('koala', serviceAccountKubeconfig(this.deps.serviceAccount));
      case 'machine':
        return this.written(`machine-${reach.clusterId}`, reach.kubeconfig);
      case 'root':
        if (!this.deps.rootKubeconfig) throw new ClusterUnreachable(reach.clusterId, 'not-configured', 'root was given no kubeconfig for its own cluster');
        return this.deps.rootKubeconfig;
    }
  }

  kubectl(target: Target, args: readonly string[], input?: string): Promise<string> {
    return theFence().guard(async () => this.ran(target, await this.run(target, this.deps.tools.kubectl, args, input)));
  }

  helm(target: Target, args: readonly string[]): Promise<string> {
    return theFence().guard(async () => this.ran(target, await this.run(target, this.deps.tools.helm, args)));
  }

  apply(target: Target, manifest: string): Promise<string> {
    return theFence().guard(async () => {
      const run = await this.run(target, this.deps.tools.kubectl, ['apply', '-f', '-'], manifest);
      const first = await this.deps.processes.run(run);
      if (first.code === 0) return first.stdout;
      if (!lostCreateRace(first.stderr)) throw new ClusterCommandFailed(clusterIdOf(target), run, first);
      return this.ran(target, run);
    });
  }

  pipe(target: Target, args: readonly string[], input: NodeJS.ReadableStream): Promise<string> {
    return theFence().guard(async () => {
      const run = await this.run(target, this.deps.tools.kubectl, args);
      const result = await this.deps.streams.pipe(run, input);
      if (result.code !== 0) throw new ClusterCommandFailed(clusterIdOf(target), run, result);
      return result.stdout;
    });
  }

  private async ran(target: Target, run: ProcessRun): Promise<string> {
    const result = await this.deps.processes.run(run);
    if (result.code !== 0) throw new ClusterCommandFailed(clusterIdOf(target), run, result);
    return result.stdout;
  }

  async packageChart(chartDir: string, out: string): Promise<void> {
    const run: ProcessRun = { command: this.deps.tools.helm, args: ['package', chartDir, '-d', out] };
    const result = await this.deps.processes.run(run);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `helm package of ${chartDir} exited ${result.code}`);
  }

  start(target: Target, args: readonly string[], io?: Io): Promise<Followed> {
    return theFence().guard(async () => this.deps.streams.start(await this.run(target, this.deps.tools.kubectl, args), io));
  }

  startHelm(target: Target, args: readonly string[], io?: Io): Promise<Followed> {
    return theFence().guard(async () => this.deps.streams.start(await this.run(target, this.deps.tools.helm, args), io));
  }

  follow(target: Target, args: readonly string[], onOutput: (chunk: string) => void): Promise<Followed> {
    return theFence().guard(async () => this.deps.streams.follow(await this.run(target, this.deps.tools.kubectl, args), onOutput));
  }

  private async run(target: Target, command: string, args: readonly string[], input?: string): Promise<ProcessRun> {
    return { command, args: ['--kubeconfig', await this.kubeconfigOf(target), ...args], input };
  }

  private async written(name: string, kubeconfig: string): Promise<string> {
    const where = join(this.deps.folder, `kubeconfig-${name}`);
    await writePrivate(where, kubeconfig);
    return where;
  }
}

export interface RecordRunners {
  kubectl(cluster: { id: string }, args: readonly string[]): Promise<string>;
  helm(cluster: { id: string }, args: readonly string[]): Promise<string>;
  apply(cluster: { id: string }, manifest: string): Promise<void>;
}

export const runnersByRecord = (access: Pick<ClusterAccess, 'kubectl' | 'helm' | 'apply'>): RecordRunners => ({
  kubectl: (cluster, args) => access.kubectl(cluster.id, args),
  helm: (cluster, args) => access.helm(cluster.id, args),
  apply: async (cluster, manifest) => { await access.apply(cluster.id, manifest); },
});

const REPO = resolve(import.meta.dirname, '../../../../../');
export interface ClusterAccessFrom {
  role: PlatformRole;
  clusters?: Pick<InfrastructureStore, 'getClusters'> | undefined;
  dataKey?: SecretKey | undefined;
}

export function clusterAccessFrom(settings: ClusterSettings, from: ClusterAccessFrom): ClusterAccess {
  const folder = join(tmpdir(), `koala-clusters-${process.pid}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const root = from.role === 'root';
  return new ClusterAccess({
    here: settings.here,
    folder,
    processes: nodeProcesses,
    streams: nodeStreams,
    tools: { kubectl: join(REPO, 'bin', 'kubectl'), helm: join(REPO, 'bin', 'helm') },
    clusters: from.clusters,
    dataKey: from.dataKey,
    serviceAccount: settings.serviceAccount,
    rootKubeconfig: root && typeof settings.rootKubeconfig === 'string' ? settings.rootKubeconfig : undefined,
  });
}
