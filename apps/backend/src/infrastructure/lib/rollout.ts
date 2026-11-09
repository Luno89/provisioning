import { assessWorkload } from './workload-health.js';

export type Rollout = { state: 'done' } | { state: 'rolling'; waiting: string } | { state: 'hopeless'; reason: string };

export const ROLLOUT_KINDS = 'deployments,statefulsets,daemonsets,replicasets,jobs,pods';

interface Owner { kind?: string; name?: string }
interface Condition { type?: string; status?: string; reason?: string; message?: string }
interface Item {
  kind?: string;
  metadata?: { name?: string; generation?: number; labels?: Record<string, string>; annotations?: Record<string, string>; ownerReferences?: Owner[]; deletionTimestamp?: string; creationTimestamp?: string };
  spec?: { replicas?: number };
  status?: {
    observedGeneration?: number; replicas?: number; updatedReplicas?: number; availableReplicas?: number; readyReplicas?: number;
    currentRevision?: string; updateRevision?: string;
    desiredNumberScheduled?: number; updatedNumberScheduled?: number; numberAvailable?: number;
    conditions?: Condition[];
  };
}

const REVISION = 'deployment.kubernetes.io/revision';
const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
const ownedBy = (item: Item, kind: string, name: string | undefined): boolean => (item.metadata?.ownerReferences ?? []).some((owner) => owner.kind === kind && owner.name === name);
const itemsOf = (listed: unknown): Item[] => ((listed as { items?: Item[] })?.items ?? []).filter((item) => item && typeof item === 'object');

function waitingOn(workload: Item): string | undefined {
  const name = `${workload.kind?.toLowerCase()}/${workload.metadata?.name}`;
  const status = workload.status ?? {};
  if ((status.observedGeneration ?? 0) < (workload.metadata?.generation ?? 0)) return `${name} has not seen its new spec`;
  if (workload.kind === 'DaemonSet') {
    const wanted = status.desiredNumberScheduled ?? 0;
    if ((status.updatedNumberScheduled ?? 0) < wanted) return `${name} has ${status.updatedNumberScheduled ?? 0} of ${wanted} updated`;
    return (status.numberAvailable ?? 0) < wanted ? `${name} has ${status.numberAvailable ?? 0} of ${wanted} available` : undefined;
  }
  const wanted = workload.spec?.replicas ?? 1;
  if (workload.kind === 'StatefulSet') {
    if (status.updateRevision && status.currentRevision !== status.updateRevision) return `${name} is rolling out`;
    return (status.readyReplicas ?? 0) < wanted ? `${name} has ${status.readyReplicas ?? 0} of ${wanted} ready` : undefined;
  }
  if ((status.updatedReplicas ?? 0) < wanted) return `${name} has ${status.updatedReplicas ?? 0} of ${wanted} updated`;
  if ((status.availableReplicas ?? 0) < wanted) return `${name} has ${status.availableReplicas ?? 0} of ${wanted} available`;
  if ((status.replicas ?? 0) > wanted) return `${name} still runs its old pods`;
  return undefined;
}

const currentSets = (items: readonly Item[], deployment: Item): Item[] => items.filter((item) => item.kind === 'ReplicaSet'
  && ownedBy(item, 'Deployment', deployment.metadata?.name)
  && item.metadata?.annotations?.[REVISION] === deployment.metadata?.annotations?.[REVISION]);

function currentPods(items: readonly Item[], workloads: readonly Item[]): Item[] {
  const pods = items.filter((item) => item.kind === 'Pod' && !item.metadata?.deletionTimestamp);
  return workloads.flatMap((workload) => {
    if (workload.kind === 'StatefulSet') {
      const revision = workload.status?.updateRevision;
      return pods.filter((pod) => ownedBy(pod, 'StatefulSet', workload.metadata?.name) && (!revision || pod.metadata?.labels?.['controller-revision-hash'] === revision));
    }
    if (workload.kind === 'DaemonSet') return pods.filter((pod) => ownedBy(pod, 'DaemonSet', workload.metadata?.name));
    const current = currentSets(items, workload);
    return pods.filter((pod) => current.some((set) => ownedBy(pod, 'ReplicaSet', set.metadata?.name)));
  });
}

function refused(items: readonly Item[], workloads: readonly Item[]): string | undefined {
  for (const deployment of workloads.filter((workload) => workload.kind === 'Deployment')) {
    for (const set of [deployment, ...currentSets(items, deployment)]) {
      const failure = set.status?.conditions?.find((condition) => condition.type === 'ReplicaFailure' && condition.status === 'True');
      if (failure) return `${deployment.metadata?.name} cannot make its pods: ${failure.message ?? failure.reason ?? 'refused'}`;
    }
  }
  return undefined;
}

export interface RolloutOptions {
  none?: 'done' | 'rolling';
  now?: number;
}

export function rolloutOf(listed: unknown, options: RolloutOptions = {}): Rollout {
  const items = itemsOf(listed);
  const workloads = items.filter((item) => WORKLOADS.has(item.kind ?? ''));
  if (workloads.length === 0) return options.none === 'done' ? { state: 'done' } : { state: 'rolling', waiting: 'none of its workloads is there yet' };
  const unseen = workloads.find((workload) => (workload.status?.observedGeneration ?? 0) < (workload.metadata?.generation ?? 0));
  if (unseen) return { state: 'rolling', waiting: waitingOn(unseen) ?? 'a workload has not seen its new spec' };
  const cannot = refused(items, workloads);
  if (cannot) return { state: 'hopeless', reason: cannot };
  const health = assessWorkload({ items: currentPods(items, workloads) }, options.now);
  if (health.health === 'unhealthy') return { state: 'hopeless', reason: health.reason };
  const waiting = workloads.map(waitingOn).find((reason): reason is string => reason !== undefined);
  return waiting ? { state: 'rolling', waiting } : { state: 'done' };
}

export function rolloutOfOne(listed: unknown, workload: string, options: RolloutOptions = {}): Rollout {
  const [kind, name] = workload.split('/');
  const items = itemsOf(listed).filter((item) => !WORKLOADS.has(item.kind ?? '') || (item.kind?.toLowerCase() === kind?.toLowerCase() && item.metadata?.name === name));
  return rolloutOf({ items }, options);
}

export function rolloutAcross(lists: readonly unknown[], options: RolloutOptions = {}): Rollout {
  const each = lists.map((listed) => rolloutOf(listed, options));
  return each.find((rollout) => rollout.state === 'hopeless') ?? each.find((rollout) => rollout.state === 'rolling') ?? { state: 'done' };
}

const HOOK = 'helm.sh/hook';
const madeSince = (item: Item, since: number): boolean => Date.parse(item.metadata?.creationTimestamp ?? '') >= Math.floor(since / 1000) * 1000;

export function stuckHook(listed: unknown, since: number, now: number = Date.now()): string | undefined {
  const items = itemsOf(listed);
  const hooks = items.filter((item) => item.kind === 'Job' && item.metadata?.annotations?.[HOOK] && madeSince(item, since));
  const pods = items.filter((item) => item.kind === 'Pod' && !item.metadata?.deletionTimestamp && hooks.some((job) => ownedBy(item, 'Job', job.metadata?.name)));
  if (pods.length === 0) return undefined;
  const health = assessWorkload({ items: pods }, now);
  return health.health === 'unhealthy' ? `the chart's ${health.reason}` : undefined;
}
