import { assessWorkload } from '../../infrastructure/lib/workload-health.js';

export const UPGRADE_WORDS = {
  running: (tag: string) => `Running ${tag}`,
  upgrading: (from: string, to: string) => `Upgrading from ${from} to ${to}`,
  upgraded: (to: string) => `Upgraded to ${to}`,
  rolledBack: (to: string, from: string) => `The upgrade to ${to} failed, so it was rolled back to ${from}`,
  notRolledBack: (to: string, from: string) => `The upgrade to ${to} failed, and rolling back to ${from} did not finish`,
  wrongChart: (to: string) => `The chart root sent for ${to} is not the one it released (its sha256 differs), so nothing was changed`,
  notADigest: (digest: string, to: string) => `Root named ${digest} as the image of ${to}, which is not a digest, so nothing was changed`,
} as const;

export const withWhy = (words: string, why: string): string => `${words}: ${why}`.slice(0, 500);

export type Rollout = { state: 'done' } | { state: 'rolling'; waiting: string } | { state: 'hopeless'; reason: string };

interface Owner { kind?: string; name?: string }
interface Item {
  kind?: string;
  metadata?: { name?: string; generation?: number; labels?: Record<string, string>; annotations?: Record<string, string>; ownerReferences?: Owner[]; deletionTimestamp?: string; creationTimestamp?: string };
  spec?: { replicas?: number };
  status?: {
    observedGeneration?: number; replicas?: number; updatedReplicas?: number; availableReplicas?: number; readyReplicas?: number;
    currentRevision?: string; updateRevision?: string; succeeded?: number;
  } & Record<string, unknown>;
}

const REVISION = 'deployment.kubernetes.io/revision';
const ownedBy = (item: Item, kind: string, name: string | undefined): boolean => (item.metadata?.ownerReferences ?? []).some((owner) => owner.kind === kind && owner.name === name);

function waitingOn(workload: Item): string | undefined {
  const name = `${workload.kind?.toLowerCase()}/${workload.metadata?.name}`;
  const wanted = workload.spec?.replicas ?? 1;
  const status = workload.status ?? {};
  if ((status.observedGeneration ?? 0) < (workload.metadata?.generation ?? 0)) return `${name} has not seen its new spec`;
  if (workload.kind === 'StatefulSet') {
    if (status.updateRevision && status.currentRevision !== status.updateRevision) return `${name} is rolling out`;
    return (status.readyReplicas ?? 0) < wanted ? `${name} has ${status.readyReplicas ?? 0} of ${wanted} ready` : undefined;
  }
  if ((status.updatedReplicas ?? 0) < wanted) return `${name} has ${status.updatedReplicas ?? 0} of ${wanted} updated`;
  if ((status.availableReplicas ?? 0) < wanted) return `${name} has ${status.availableReplicas ?? 0} of ${wanted} available`;
  if ((status.replicas ?? 0) > wanted) return `${name} still runs its old pods`;
  return undefined;
}

function currentPods(items: readonly Item[], workloads: readonly Item[]): Item[] {
  const sets = items.filter((item) => item.kind === 'ReplicaSet');
  const pods = items.filter((item) => item.kind === 'Pod' && !item.metadata?.deletionTimestamp);
  return workloads.flatMap((workload) => {
    if (workload.kind === 'StatefulSet') {
      const revision = workload.status?.updateRevision;
      return pods.filter((pod) => ownedBy(pod, 'StatefulSet', workload.metadata?.name) && (!revision || pod.metadata?.labels?.['controller-revision-hash'] === revision));
    }
    const revision = workload.metadata?.annotations?.[REVISION];
    const current = sets.filter((set) => ownedBy(set, 'Deployment', workload.metadata?.name) && set.metadata?.annotations?.[REVISION] === revision);
    return pods.filter((pod) => current.some((set) => ownedBy(pod, 'ReplicaSet', set.metadata?.name)));
  });
}

const HOOK = 'helm.sh/hook';
const itemsOf = (listed: unknown): Item[] => ((listed as { items?: Item[] })?.items ?? []).filter((item) => item && typeof item === 'object');
const madeSince = (item: Item, since: number): boolean => Date.parse(item.metadata?.creationTimestamp ?? '') >= Math.floor(since / 1000) * 1000;

export function rolloutOf(listed: unknown, now: number = Date.now()): Rollout {
  const items = itemsOf(listed);
  const workloads = items.filter((item) => item.kind === 'Deployment' || item.kind === 'StatefulSet');
  if (workloads.length === 0) return { state: 'rolling', waiting: 'none of the release\'s workloads is there yet' };
  const health = assessWorkload({ items: currentPods(items, workloads) }, now);
  if (health.health === 'unhealthy') return { state: 'hopeless', reason: health.reason };
  const waiting = workloads.map(waitingOn).find((reason): reason is string => reason !== undefined);
  return waiting ? { state: 'rolling', waiting } : { state: 'done' };
}

export function stuckHook(listed: unknown, since: number, now: number = Date.now()): string | undefined {
  const items = itemsOf(listed);
  const hooks = items.filter((item) => item.kind === 'Job' && item.metadata?.annotations?.[HOOK] && madeSince(item, since));
  const pods = items.filter((item) => item.kind === 'Pod' && !item.metadata?.deletionTimestamp && hooks.some((job) => ownedBy(item, 'Job', job.metadata?.name)));
  if (pods.length === 0) return undefined;
  const health = assessWorkload({ items: pods }, now);
  return health.health === 'unhealthy' ? `the chart's ${health.reason}` : undefined;
}

export const abandonedJobs = (listed: unknown, since: number): string[] => itemsOf(listed)
  .filter((item) => item.kind === 'Job' && madeSince(item, since) && (item.status?.succeeded ?? 0) === 0)
  .map((item) => item.metadata?.name)
  .filter((name): name is string => name !== undefined);
