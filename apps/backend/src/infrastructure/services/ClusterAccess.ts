import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { decryptValue, nodeProcesses, nodeStreams, writePrivate, type Followed, type PlatformRole, type ProcessResult, type ProcessRun, type Processes, type SecretKey, type Streams } from '../../platform/index.js';
import { lostCreateRace } from '../lib/apply-races.js';
import { placeOf, serviceAccountFrom, serviceAccountKubeconfig, type Here, type Reach, type ServiceAccount, type WhyUnreachable } from '../lib/cluster-places.js';
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

  async reach(clusterId: string): Promise<Reach> {
    const record = this.deps.clusters ? (await this.deps.clusters.getClusters()).find((cluster) => cluster.id === clusterId) : undefined;
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

  async kubectl(target: Target, args: readonly string[], input?: string): Promise<string> {
    return this.ran(target, await this.run(target, this.deps.tools.kubectl, args, input));
  }

  async helm(target: Target, args: readonly string[]): Promise<string> {
    return this.ran(target, await this.run(target, this.deps.tools.helm, args));
  }

  async apply(target: Target, manifest: string): Promise<string> {
    const run = await this.run(target, this.deps.tools.kubectl, ['apply', '-f', '-'], manifest);
    const first = await this.deps.processes.run(run);
    if (first.code === 0) return first.stdout;
    if (!lostCreateRace(first.stderr)) throw new ClusterCommandFailed(clusterIdOf(target), run, first);
    return this.ran(target, run);
  }

  async pipe(target: Target, args: readonly string[], input: NodeJS.ReadableStream): Promise<string> {
    const run = await this.run(target, this.deps.tools.kubectl, args);
    const result = await this.deps.streams.pipe(run, input);
    if (result.code !== 0) throw new ClusterCommandFailed(clusterIdOf(target), run, result);
    return result.stdout;
  }

  private async ran(target: Target, run: ProcessRun): Promise<string> {
    const result = await this.deps.processes.run(run);
    if (result.code !== 0) throw new ClusterCommandFailed(clusterIdOf(target), run, result);
    return result.stdout;
  }

  async follow(target: Target, args: readonly string[], onOutput: (chunk: string) => void): Promise<Followed> {
    return this.deps.streams.follow(await this.run(target, this.deps.tools.kubectl, args), onOutput);
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

const REPO = resolve(import.meta.dirname, '../../../../../');
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface ClusterAccessFrom {
  role: PlatformRole;
  clusters?: Pick<InfrastructureStore, 'getClusters'> | undefined;
  dataKey?: SecretKey | undefined;
}

export function clusterAccessFrom(env: Readonly<Record<string, string | undefined>>, from: ClusterAccessFrom): ClusterAccess {
  const folder = join(tmpdir(), `koala-clusters-${process.pid}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const root = from.role === 'root';
  return new ClusterAccess({
    here: { koalaMachineId: env.INSTANCE_MACHINE_ID?.trim() || undefined, root },
    folder,
    processes: nodeProcesses,
    streams: nodeStreams,
    tools: { kubectl: join(REPO, 'bin', 'kubectl'), helm: join(REPO, 'bin', 'helm') },
    clusters: from.clusters,
    dataKey: from.dataKey,
    serviceAccount: serviceAccountFrom(env, SERVICE_ACCOUNT),
    rootKubeconfig: root ? env.POOL_KUBECONFIG?.trim() || undefined : undefined,
  });
}
