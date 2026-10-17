import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';
import {
  CPU_BY_POD, MEMORY_BY_POD, brokenWorkloads, clusterWorkloads,
  type NamespaceJson, type PodJson, type UsageSample, type Workload, type WorkloadScope,
} from '../lib/cluster-workloads.js';
import { platformServices, type HelmReleaseJson, type PlatformService } from '../lib/platform-services.js';
import { MonitoringError, namespaceOf, type PrometheusClient, type Sample, type Viewer } from './MonitoringService.js';

export interface ClusterNode {
  name: string;
  ready: boolean;
  roles: string[];
  version?: string | undefined;
  cpuCores?: number | undefined;
  memoryBytes?: number | undefined;
  gpus?: number | undefined;
}

export interface ClusterContents {
  clusterId: string;
  readAt: string;
  reachable: boolean;
  problem?: string | undefined;
  ownsCluster: boolean;
  workloads: Workload[];
  finishedJobs: number;
  measured: boolean;
  services?: PlatformService[] | undefined;
  releases?: HelmReleaseJson[] | undefined;
  nodes?: ClusterNode[] | undefined;
}

export interface BrokenWorkload extends Workload {
  clusterId: string;
  clusterName: string;
}

interface Raw {
  readAt: string;
  pods: PodJson[];
  namespaces: NamespaceJson[];
  nodes: ClusterNode[];
  releases: HelmReleaseJson[] | undefined;
  memory?: UsageSample[] | undefined;
  cpu?: UsageSample[] | undefined;
}

export interface ClusterContentsDeps {
  monitoring: {
    clustersOf(viewer: Viewer): Promise<ClusterMetadata[]>;
    ownsCluster(viewer: Viewer, cluster: ClusterMetadata): boolean;
    reach(cluster: ClusterMetadata): Promise<{ prometheus?: PrometheusClient | undefined }>;
  };
  deployments(): Promise<DeploymentMetadata[]>;
  kubectl(cluster: ClusterMetadata, args: string[]): Promise<string>;
  helm(cluster: ClusterMetadata, args: string[]): Promise<string>;
  labelOf(ownerId: string): string;
  now?: () => Date;
}

export const READ_FRESH_MS = 20_000;

const quantity = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const match = /^([0-9.]+)([a-zA-Z]*)$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  const units: Record<string, number> = { '': 1, m: 0.001, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  const unit = units[match[2] ?? ''];
  return unit === undefined ? undefined : n * unit;
};

export function nodesFrom(json: string): ClusterNode[] {
  const items = (JSON.parse(json) as { items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> }; status?: { conditions?: Array<{ type?: string; status?: string }>; capacity?: Record<string, string>; nodeInfo?: { kubeletVersion?: string } } }> }).items ?? [];
  return items.map((node) => {
    const labels = node.metadata?.labels ?? {};
    const capacity = node.status?.capacity ?? {};
    const gpus = (quantity(capacity['nvidia.com/gpu']) ?? 0) + (quantity(capacity['amd.com/gpu']) ?? 0);
    return {
      name: node.metadata?.name ?? 'node',
      ready: node.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True') ?? false,
      roles: Object.keys(labels).filter((key) => key.startsWith('node-role.kubernetes.io/')).map((key) => key.slice('node-role.kubernetes.io/'.length)),
      ...(node.status?.nodeInfo?.kubeletVersion ? { version: node.status.nodeInfo.kubeletVersion } : {}),
      ...(quantity(capacity.cpu) !== undefined ? { cpuCores: quantity(capacity.cpu) } : {}),
      ...(quantity(capacity.memory) !== undefined ? { memoryBytes: quantity(capacity.memory) } : {}),
      ...(gpus ? { gpus } : {}),
    };
  });
}

const usage = (samples: Sample[]): UsageSample[] =>
  samples.filter((sample) => sample.metric.namespace && sample.metric.pod).map((sample) => ({ namespace: sample.metric.namespace!, pod: sample.metric.pod!, value: sample.value }));

export class ClusterContentsService {
  private readonly now: () => Date;
  private readonly cache = new Map<string, { at: number; raw: Promise<Raw> }>();

  constructor(private readonly deps: ClusterContentsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private read(cluster: ClusterMetadata): Promise<Raw> {
    const cached = this.cache.get(cluster.id);
    if (cached && this.now().getTime() - cached.at < READ_FRESH_MS) return cached.raw;
    const raw = this.readNow(cluster);
    this.cache.set(cluster.id, { at: this.now().getTime(), raw });
    raw.catch(() => this.cache.delete(cluster.id));
    return raw;
  }

  private async readNow(cluster: ClusterMetadata): Promise<Raw> {
    const [pods, namespaces, nodes, releases, reached] = await Promise.all([
      this.deps.kubectl(cluster, ['get', 'pods', '--all-namespaces', '-o', 'json']),
      this.deps.kubectl(cluster, ['get', 'namespaces', '-o', 'json']),
      this.deps.kubectl(cluster, ['get', 'nodes', '-o', 'json']).catch(() => '{"items":[]}'),
      this.deps.helm(cluster, ['list', '-A', '-o', 'json']).then((out) => JSON.parse(out) as HelmReleaseJson[]).catch(() => undefined),
      this.deps.monitoring.reach(cluster).catch(() => ({ prometheus: undefined })),
    ]);
    const [memory, cpu] = reached.prometheus
      ? await Promise.all([reached.prometheus.query(MEMORY_BY_POD).then(usage).catch(() => undefined), reached.prometheus.query(CPU_BY_POD).then(usage).catch(() => undefined)])
      : [undefined, undefined];
    return {
      readAt: this.now().toISOString(),
      pods: (JSON.parse(pods) as { items?: PodJson[] }).items ?? [],
      namespaces: (JSON.parse(namespaces) as { items?: NamespaceJson[] }).items ?? [],
      nodes: nodesFrom(nodes),
      releases,
      ...(memory ? { memory } : {}),
      ...(cpu ? { cpu } : {}),
    };
  }

  private async scope(viewer: Viewer, cluster: ClusterMetadata): Promise<WorkloadScope> {
    const deployments = (await this.deps.deployments()).filter((dep) => dep.clusterId === cluster.id && dep.status !== 'destroying');
    return {
      ownsCluster: this.deps.monitoring.ownsCluster(viewer, cluster),
      viewerLabel: this.deps.labelOf(viewer.id),
      apps: deployments.map((dep) => ({ id: dep.id, name: dep.name, namespace: namespaceOf(dep), mine: dep.ownerId === viewer.id })),
    };
  }

  private async contentsOf(viewer: Viewer, cluster: ClusterMetadata): Promise<ClusterContents> {
    const ownsCluster = this.deps.monitoring.ownsCluster(viewer, cluster);
    const empty = { clusterId: cluster.id, ownsCluster, workloads: [], finishedJobs: 0, measured: false };
    if (cluster.status !== 'healthy') return { ...empty, readAt: this.now().toISOString(), reachable: false, problem: `it is ${cluster.status}` };
    let raw: Raw;
    try {
      raw = await this.read(cluster);
    } catch (err) {
      return { ...empty, readAt: this.now().toISOString(), reachable: false, problem: `it does not answer (${(err as Error).message.split('\n')[0]})` };
    }
    const { workloads, finishedJobs, measured } = clusterWorkloads(raw, await this.scope(viewer, cluster), this.now().getTime());
    return {
      clusterId: cluster.id,
      readAt: raw.readAt,
      reachable: true,
      ownsCluster,
      workloads,
      finishedJobs,
      measured,
      ...(ownsCluster ? {
        services: platformServices(workloads, raw.releases ?? []),
        ...(raw.releases ? { releases: raw.releases } : {}),
        nodes: raw.nodes,
      } : {}),
    };
  }

  async contents(viewer: Viewer, clusterId: string): Promise<ClusterContents> {
    const cluster = (await this.deps.monitoring.clustersOf(viewer)).find((entry) => entry.id === clusterId);
    if (!cluster) throw new MonitoringError(404, 'no such cluster');
    return this.contentsOf(viewer, cluster);
  }

  async broken(viewer: Viewer): Promise<BrokenWorkload[]> {
    const clusters = (await this.deps.monitoring.clustersOf(viewer)).filter((cluster) => cluster.status === 'healthy');
    const per = await Promise.all(clusters.map(async (cluster) => {
      const contents = await this.contentsOf(viewer, cluster);
      return brokenWorkloads(contents.workloads).map((workload) => ({ ...workload, clusterId: cluster.id, clusterName: cluster.name }));
    }));
    return per.flat();
  }
}
