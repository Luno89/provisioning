import { assessWorkload, podTroubles, type Trouble } from './workload-health.js';

export type Rollout = { state: 'done' } | { state: 'rolling'; waiting: string } | { state: 'hopeless'; reason: string };

export const ROLLOUT_KINDS = 'deployments,statefulsets,daemonsets,replicasets,jobs,pods';

interface Owner { kind?: string; name?: string }
interface Condition { type?: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string }
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

function waitsForRoom(pod: Item): string | undefined {
  const unplaced = pod.status?.conditions?.find((condition) => condition.type === 'PodScheduled' && condition.status === 'False');
  return unplaced ? `${pod.metadata?.name} waits for room: ${unplaced.message ?? unplaced.reason ?? 'the scheduler has not placed it'}` : undefined;
}

export interface RolloutOptions {
  none?: 'done' | 'rolling';
}

type Crash = Extract<Trouble, { kind: 'crashing' }> & { job?: string };

interface Seen {
  name: string;
  state: 'available' | 'failed' | 'changing';
  waiting: string;
  readyAt: number;
  crashes: Crash[];
}

interface Look {
  seen: Seen[];
  judged: Seen[];
  hopeless?: string;
  waiting?: string;
}

const conditionTrue = (item: Item, type: string): Condition | undefined => item.status?.conditions?.find((condition) => condition.type === type && condition.status === 'True');
const crashesOf = (troubles: readonly Trouble[]): Crash[] => troubles.filter((trouble): trouble is Crash => trouble.kind === 'crashing');
const changing = (name: string, waiting: string): Seen => ({ name, state: 'changing', waiting, readyAt: 0, crashes: [] });
const latest = (times: readonly number[]): number => times.filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0);
const podsOfJob = (items: readonly Item[], job: Item): Item[] => items.filter((item) => item.kind === 'Pod' && !item.metadata?.deletionTimestamp && ownedBy(item, 'Job', job.metadata?.name));

function workloadSeen(items: readonly Item[], workload: Item): Seen {
  const pods = currentPods(items, [workload]);
  const waiting = waitingOn(workload);
  return {
    name: `${workload.kind?.toLowerCase()}/${workload.metadata?.name}`,
    state: waiting ? 'changing' : 'available',
    waiting: waiting ?? '',
    readyAt: latest(pods.map((pod) => Date.parse(conditionTrue(pod, 'Ready')?.lastTransitionTime ?? ''))),
    crashes: crashesOf(podTroubles(pods)),
  };
}

function jobSeen(items: readonly Item[], job: Item, judged: boolean): Seen {
  const name = `job/${job.metadata?.name}`;
  const status = job.status as (Item['status'] & { succeeded?: number; active?: number; completionTime?: string }) | undefined;
  const complete = conditionTrue(job, 'Complete');
  if ((status?.succeeded ?? 0) > 0 || complete) return { name, state: 'available', waiting: '', readyAt: latest([Date.parse(complete?.lastTransitionTime ?? status?.completionTime ?? '')]), crashes: [] };
  if (conditionTrue(job, 'Failed')) return { name, state: 'failed', waiting: '', readyAt: 0, crashes: [] };
  const pods = podsOfJob(items, job);
  const crashes = judged ? crashesOf(podTroubles(pods)).map((crash) => ({ ...crash, job: job.metadata?.name ?? '' })) : [];
  return { ...changing(name, (status?.active ?? 0) > 0 || pods.length > 0 ? `${name} runs` : `${name} has not started`), crashes };
}

type Verdict = { final: string } | { note: string };

function verdictOn(crash: Crash, own: Seen, seen: readonly Seen[]): Verdict {
  const others = seen.filter((other) => other !== own);
  const awaited = others.find((other) => other.state === 'changing' && other.crashes.length === 0);
  if (awaited) return { note: `${crash.name} restarts while ${awaited.waiting}` };
  const last = others.filter((other) => other.state === 'available').reduce<Seen | undefined>((a, b) => (a && a.readyAt >= b.readyAt ? a : b), undefined);
  if (!last || crash.exitedAt > last.readyAt) return { final: crash.reason };
  return { note: `${crash.name} restarts, and is watched for its next try now that ${last.name} is available` };
}

function verdicts(judged: readonly Seen[], seen: readonly Seen[]): { own: Seen; crash: Crash; verdict: Verdict }[] {
  return judged.flatMap((own) => own.crashes.map((crash) => ({ own, crash, verdict: verdictOn(crash, own, seen) })));
}

function look(items: readonly Item[], options: RolloutOptions, only?: (workload: Item) => boolean): Look {
  const workloads = items.filter((item) => WORKLOADS.has(item.kind ?? ''));
  const judged = only ? workloads.filter(only) : workloads;
  const jobs = items.filter((item) => item.kind === 'Job' && !item.metadata?.deletionTimestamp).map((job) => jobSeen(items, job, false));
  if (judged.length === 0) {
    if (options.none === 'done') return { seen: jobs, judged: [] };
    const waiting = 'none of its workloads is there yet';
    return { seen: [changing('its workloads', waiting)], judged: [], waiting };
  }
  const unseen = judged.find((workload) => (workload.status?.observedGeneration ?? 0) < (workload.metadata?.generation ?? 0));
  if (unseen) {
    const waiting = waitingOn(unseen) ?? 'a workload has not seen its new spec';
    return { seen: [changing(`${unseen.kind?.toLowerCase()}/${unseen.metadata?.name}`, waiting)], judged: [], waiting };
  }
  const cannot = refused(items, judged);
  if (cannot) return { seen: [], judged: [], hopeless: cannot };
  const pods = currentPods(items, judged);
  const pulled = podTroubles(pods).find((trouble) => trouble.kind === 'refused');
  if (pulled) return { seen: [], judged: [], hopeless: pulled.reason };
  const judgedSeen = judged.map((workload) => workloadSeen(items, workload));
  const siblings = workloads.filter((workload) => !judged.includes(workload)).map((workload) => workloadSeen(items, workload));
  const waiting = judged.map(waitingOn).find((reason): reason is string => reason !== undefined);
  const room = pods.map(waitsForRoom).find((reason): reason is string => reason !== undefined);
  return { seen: [...judgedSeen, ...siblings, ...jobs], judged: judgedSeen, ...(waiting ? { waiting: room ? `${waiting}; ${room}` : waiting } : {}) };
}

const notesOf = (judged: ReturnType<typeof verdicts>, own: Seen): string[] => judged.flatMap((one) => (one.own === own && 'note' in one.verdict ? [one.verdict.note] : []));

function decided(looks: readonly Look[]): Rollout {
  const hopeless = looks.find((looked) => looked.hopeless !== undefined)?.hopeless;
  if (hopeless) return { state: 'hopeless', reason: hopeless };
  const judged = verdicts(looks.flatMap((looked) => looked.judged), looks.flatMap((looked) => looked.seen));
  for (const { verdict } of judged) if ('final' in verdict) return { state: 'hopeless', reason: verdict.final };
  const lines = [looks.map((looked) => looked.waiting).find((line) => line !== undefined), ...judged.map(({ verdict }) => ('note' in verdict ? verdict.note : undefined))]
    .filter((line): line is string => line !== undefined);
  return lines.length > 0 ? { state: 'rolling', waiting: lines.join('; ') } : { state: 'done' };
}

export function rolloutOf(listed: unknown, options: RolloutOptions = {}): Rollout {
  return decided([look(itemsOf(listed), options)]);
}

export function rolloutOfOne(listed: unknown, workload: string, options: RolloutOptions = {}): Rollout {
  const [kind, name] = workload.split('/');
  return decided([look(itemsOf(listed), options, (item) => item.kind?.toLowerCase() === kind?.toLowerCase() && item.metadata?.name === name)]);
}

export function rolloutAcross(lists: readonly unknown[], options: RolloutOptions = {}): Rollout {
  return decided(lists.map((listed) => look(itemsOf(listed), options)));
}

export const SETUP_LABEL = 'koala.app/setup';

export type ReleaseRollout = { state: 'done' } | { state: 'rolling'; waiting: string[] } | { state: 'hopeless'; reason: string; job?: string };

function jobRefused(items: readonly Item[], job: Item): { reason: string; job: string } | undefined {
  const name = `job/${job.metadata?.name}`;
  const failed = conditionTrue(job, 'Failed');
  if (failed) return { reason: `${name} failed: ${failed.message ?? failed.reason ?? 'its pod ended in failure'}`, job: job.metadata?.name ?? '' };
  const pulled = podTroubles(podsOfJob(items, job)).find((trouble) => trouble.kind === 'refused');
  return pulled ? { reason: `${name}: ${pulled.reason}`, job: job.metadata?.name ?? '' } : undefined;
}

function jobLine(items: readonly Item[], job: Item, seen: Seen): string {
  const unplaced = podsOfJob(items, job).map((pod) => pod.status?.conditions?.find((condition) => condition.type === 'PodScheduled' && condition.status === 'False')).find((condition) => condition !== undefined);
  return unplaced ? `job/${job.metadata?.name} waits for room: ${unplaced.message ?? unplaced.reason ?? 'the scheduler has not placed it'}` : seen.waiting;
}

export function releaseRollout(listed: unknown): ReleaseRollout {
  const items = itemsOf(listed);
  const workloads = items.filter((item) => WORKLOADS.has(item.kind ?? ''));
  const jobs = items.filter((item) => item.kind === 'Job' && item.metadata?.labels?.[SETUP_LABEL] !== undefined && !item.metadata.deletionTimestamp);
  const looked: Look = workloads.length > 0 ? look(items.filter((item) => item.kind !== 'Job'), {}) : { seen: [], judged: [] };
  if (looked.hopeless) return { state: 'hopeless', reason: looked.hopeless };
  const jobsSeen = jobs.map((job) => ({ job, seen: jobSeen(items, job, true) }));
  for (const { job, seen } of jobsSeen) {
    const cannot = seen.state === 'available' ? undefined : jobRefused(items, job);
    if (cannot) return { state: 'hopeless', ...cannot };
  }
  const judged = verdicts([...looked.judged, ...jobsSeen.map(({ seen }) => seen)], [...looked.seen, ...jobsSeen.map(({ seen }) => seen)]);
  for (const { crash, verdict } of judged) {
    if (!('final' in verdict)) continue;
    return crash.job === undefined ? { state: 'hopeless', reason: verdict.final } : { state: 'hopeless', reason: `job/${crash.job}: ${verdict.final}`, job: crash.job };
  }
  const waiting: string[] = [];
  if (looked.waiting !== undefined) {
    const each = workloads.map(waitingOn).filter((line): line is string => line !== undefined);
    waiting.push(...(each.length > 0 ? each : [looked.waiting]));
  }
  waiting.push(...looked.judged.flatMap((own) => notesOf(judged, own)));
  for (const { job, seen } of jobsSeen) {
    if (seen.state === 'changing') waiting.push([jobLine(items, job, seen), ...notesOf(judged, seen)].join('; '));
  }
  return waiting.length > 0 ? { state: 'rolling', waiting } : { state: 'done' };
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
