import { join } from 'node:path';
import { decryptValue, succeeded, writePrivate, type Processes, type SecretKey } from '../../platform/index.js';
import { placeOf, serviceAccountKubeconfig, type Here, type ServiceAccount, type WhyUnreachable } from '../lib/cluster-places.js';
import type { InfrastructureStore } from '../store.js';

export class ClusterUnreachable extends Error {
  constructor(readonly clusterId: string, readonly why: WhyUnreachable, message: string) {
    super(message);
    this.name = 'ClusterUnreachable';
  }
}

export interface ClusterAccessDeps {
  clusters: Pick<InfrastructureStore, 'getClusters'>;
  here: Here;
  folder: string;
  processes: Processes;
  tools: { kubectl: string; helm: string };
  dataKey?: SecretKey | undefined;
  serviceAccount?: ServiceAccount | undefined;
  rootKubeconfig?: string | undefined;
}

export interface ClusterRun {
  input?: string | undefined;
  handed?: string | undefined;
}

const HANDED_WHEN: ReadonlySet<WhyUnreachable> = new Set(['stopped', 'not-started']);

export class ClusterAccess {
  constructor(private readonly deps: ClusterAccessDeps) {}

  async kubeconfigFor(clusterId: string, handed?: string): Promise<string> {
    const record = (await this.deps.clusters.getClusters()).find((cluster) => cluster.id === clusterId);
    const place = placeOf(clusterId, record, this.deps.here);
    if (handed !== undefined) {
      const machine = place.kind === 'machine' || (place.kind === 'unreachable' && HANDED_WHEN.has(place.why));
      if (!machine) throw new ClusterUnreachable(clusterId, place.kind === 'unreachable' ? place.why : 'other-kind', `a kubeconfig is handed over only for a machine another step started, and ${clusterId} is not one`);
      return this.written(`handed-${clusterId}`, handed);
    }
    switch (place.kind) {
      case 'unreachable':
        throw new ClusterUnreachable(clusterId, place.why, place.reason);
      case 'koala':
        if (!this.deps.serviceAccount) throw new ClusterUnreachable(clusterId, 'no-account', 'this process is not running inside Koala\'s cluster, so it has no account there to reach it with');
        return this.written('koala', serviceAccountKubeconfig(this.deps.serviceAccount));
      case 'machine':
        if (!this.deps.dataKey) throw new ClusterUnreachable(clusterId, 'no-key', 'this process holds no data key, so it cannot open a machine\'s kubeconfig; the workflow that started the machine hands it over');
        return this.written(`machine-${clusterId}`, decryptValue(place.sealed, this.deps.dataKey));
      case 'root':
        if (!this.deps.rootKubeconfig) throw new ClusterUnreachable(clusterId, 'not-configured', 'root was given no kubeconfig for its own cluster');
        return this.deps.rootKubeconfig;
    }
  }

  async kubectl(clusterId: string, args: readonly string[], run: ClusterRun = {}): Promise<string> {
    const kubeconfig = await this.kubeconfigFor(clusterId, run.handed);
    return succeeded(this.deps.processes, { command: this.deps.tools.kubectl, args: ['--kubeconfig', kubeconfig, ...args], input: run.input });
  }

  async helm(clusterId: string, args: readonly string[], run: ClusterRun = {}): Promise<string> {
    const kubeconfig = await this.kubeconfigFor(clusterId, run.handed);
    return succeeded(this.deps.processes, { command: this.deps.tools.helm, args: ['--kubeconfig', kubeconfig, ...args], input: run.input });
  }

  private async written(name: string, kubeconfig: string): Promise<string> {
    const where = join(this.deps.folder, `kubeconfig-${name}`);
    await writePrivate(where, kubeconfig);
    return where;
  }
}
