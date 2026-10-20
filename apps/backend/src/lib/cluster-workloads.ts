import { RECENT_RESTART_MS } from './workload-health.js';

export type WorkloadState = 'ok' | 'starting' | 'warning' | 'down';
export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'Pod';
export type WorkloadGroup = 'apps' | 'koala' | 'platform' | 'other';

export type WorkloadAbout =
  | { kind: 'app'; id: string; name: string; mine: boolean }
  | { kind: 'tree'; id: string; mine: boolean; check?: boolean | undefined }
  | { kind: 'run'; id: string; mine: boolean; check?: boolean | undefined }
  | { kind: 'project'; id: string; mine: boolean; check?: boolean | undefined }
  | { kind: 'builds' }
  | { kind: 'platform' }
  | { kind: 'other' };

export interface Workload {
  namespace: string;
  kind: WorkloadKind;
  name: string;
  group: WorkloadGroup;
  about: WorkloadAbout;
  release?: string | undefined;
  pods: { total: number; ready: number };
  state: WorkloadState;
  reasons: string[];
  restarts: number;
  memoryBytes?: number | undefined;
  cpuCores?: number | undefined;
  since?: string | undefined;
}

export interface ClusterWorkloads {
  workloads: Workload[];
  finishedJobs: number;
  measured: boolean;
}

interface ContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  state?: { waiting?: { reason?: string; message?: string }; running?: object; terminated?: { reason?: string; exitCode?: number; finishedAt?: string } };
  lastState?: { terminated?: { reason?: string; exitCode?: number; finishedAt?: string } };
}

export interface PodJson {
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    ownerReferences?: Array<{ kind?: string; name?: string; controller?: boolean }>;
  };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
}

export interface NamespaceJson {
  metadata?: { name?: string; labels?: Record<string, string> };
}

export interface UsageSample {
  namespace: string;
  pod: string;
  value: number;
}

export interface WorkloadScope {
  ownsCluster: boolean;
  viewerLabel: string;
  apps: ReadonlyArray<{ id: string; name: string; namespace: string; mine: boolean }>;
}

export const PLATFORM_NAMESPACES: ReadonlySet<string> = new Set([
  'kube-system', 'kube-public', 'kube-node-lease', 'local-path-storage', 'monitoring', 'traefik', 'ingress-nginx',
  'cert-manager', 'infisical', 'infisical-operator-system', 'gitea', 'koala-egress', 'koala-registry', 'headscale',
]);
export const PLATFORM_WORKLOADS: ReadonlyArray<{ namespace: string; name: string }> = [{ namespace: 'default', name: 'provisioning-worker' }];
export const BUILD_NAMESPACES: ReadonlySet<string> = new Set(['pipeline-builds']);

export const CHECK_SPACE_PREFIX = 'space-';

const STARTING_GRACE_MS = 2 * 60_000;

const BROKEN: Record<string, string> = {
  CrashLoopBackOff: 'it keeps crashing',
  ImagePullBackOff: 'its image cannot be pulled',
  ErrImagePull: 'its image cannot be pulled',
  InvalidImageName: 'its image name is not valid',
  CreateContainerConfigError: 'its container settings are wrong, such as a secret or config map it needs that is missing',
  CreateContainerError: 'its container cannot be created',
};

const EXIT_REASONS: Record<string, string> = {
  OOMKilled: 'it ran out of memory',
  Error: 'it exited with an error',
};

const RANK: Record<WorkloadState, number> = { down: 3, warning: 2, starting: 1, ok: 0 };
const worse = (a: WorkloadState, b: WorkloadState): WorkloadState => (RANK[b] > RANK[a] ? b : a);

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function ownerOf(pod: PodJson): { kind: WorkloadKind; name: string } {
  const name = pod.metadata?.name ?? 'pod';
  const owner = pod.metadata?.ownerReferences?.find((ref) => ref.controller !== false) ?? pod.metadata?.ownerReferences?.[0];
  if (!owner?.kind || !owner.name) return { kind: 'Pod', name };
  if (owner.kind === 'ReplicaSet') {
    const hash = pod.metadata?.labels?.['pod-template-hash'];
    return { kind: 'Deployment', name: hash && owner.name.endsWith(`-${hash}`) ? owner.name.slice(0, -(hash.length + 1)) : owner.name };
  }
  if (owner.kind === 'StatefulSet' || owner.kind === 'DaemonSet' || owner.kind === 'Job') return { kind: owner.kind, name: owner.name };
  return { kind: 'Pod', name };
}

function releaseOf(pod: PodJson): string | undefined {
  const labels = pod.metadata?.labels ?? {};
  return labels['app.kubernetes.io/instance'] ?? labels.release;
}

const containersOf = (pod: PodJson): ContainerStatus[] => [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];

interface PodVerdict {
  state: WorkloadState;
  reason?: string | undefined;
  ready: boolean;
  restarts: number;
  failed: boolean;
  succeeded: boolean;
}

export function podVerdict(pod: PodJson, now: number): PodVerdict {
  const phase = pod.status?.phase;
  const containers = containersOf(pod);
  const restarts = containers.reduce((sum, container) => sum + (container.restartCount ?? 0), 0);
  const ready = phase === 'Running' && (pod.status?.containerStatuses ?? []).length > 0 && (pod.status?.containerStatuses ?? []).every((container) => container.ready);
  const age = now - Date.parse(pod.metadata?.creationTimestamp ?? new Date(now).toISOString());
  const base = { ready, restarts, failed: false, succeeded: false };

  if (phase === 'Succeeded') return { ...base, state: 'ok', succeeded: true };
  if (phase === 'Failed') {
    const exited = containers.map((container) => container.state?.terminated?.reason).find((reason) => reason && reason !== 'Completed' && reason !== 'Unknown');
    const why = pod.status?.message ?? (exited ? EXIT_REASONS[exited] ?? exited : undefined) ?? pod.status?.reason ?? 'it stopped';
    return { ...base, state: 'down', failed: true, reason: why };
  }
  for (const container of containers) {
    const waiting = container.state?.waiting?.reason;
    if (waiting && BROKEN[waiting]) {
      const last = container.lastState?.terminated?.reason;
      const lastWhy = waiting === 'CrashLoopBackOff' && last && EXIT_REASONS[last] ? `: ${EXIT_REASONS[last]}` : '';
      return { ...base, state: 'down', reason: `${BROKEN[waiting]}${lastWhy}` };
    }
  }
  if (phase === 'Pending') {
    const unscheduled = pod.status?.conditions?.find((condition) => condition.type === 'PodScheduled' && condition.status === 'False');
    if (age < STARTING_GRACE_MS) return { ...base, state: 'starting', reason: 'it is starting' };
    if (unscheduled) return { ...base, state: 'warning', reason: `it waits for room on a node${unscheduled.message ? `: ${unscheduled.message}` : ''}` };
    return { ...base, state: 'warning', reason: 'it has been starting for a while' };
  }
  const recent = containers
    .map((container) => container.lastState?.terminated)
    .filter((terminated): terminated is NonNullable<typeof terminated> => Boolean(terminated?.finishedAt) && now - Date.parse(terminated!.finishedAt!) < RECENT_RESTART_MS);
  if (recent.length) {
    const last = recent.map((terminated) => terminated.reason).find(Boolean);
    return { ...base, state: 'warning', reason: `it restarted in the last hour${last ? `: ${EXIT_REASONS[last] ?? last}` : ''}` };
  }
  if (!ready) return { ...base, state: age < STARTING_GRACE_MS ? 'starting' : 'warning', reason: age < STARTING_GRACE_MS ? 'it is starting' : 'it is running but not ready' };
  return { ...base, state: 'ok' };
}

function aboutOf(namespace: string, name: string, labels: Record<string, string>, scope: WorkloadScope): { group: WorkloadGroup; about: WorkloadAbout } {
  const app = scope.apps.find((entry) => entry.namespace === namespace);
  if (app) return { group: 'apps', about: { kind: 'app', id: app.id, name: app.name, mine: app.mine } };
  const owner = labels['koala.dev/owner'];
  const mine = owner === scope.viewerLabel;
  const check = owner?.startsWith(CHECK_SPACE_PREFIX) ? { check: true } : {};
  const run = labels['koala.dev/run'];
  if (run) {
    const tree = run.startsWith('tree-') ? run.slice('tree-'.length) : undefined;
    return { group: 'koala', about: tree ? { kind: 'tree', id: tree, mine, ...check } : { kind: 'run', id: run, mine, ...check } };
  }
  const project = labels['koala.dev/project'];
  if (project) return { group: 'koala', about: { kind: 'project', id: project, mine, ...check } };
  if (BUILD_NAMESPACES.has(namespace)) return { group: 'koala', about: { kind: 'builds' } };
  if (PLATFORM_NAMESPACES.has(namespace) || PLATFORM_WORKLOADS.some((entry) => entry.namespace === namespace && entry.name === name)) return { group: 'platform', about: { kind: 'platform' } };
  return { group: 'other', about: { kind: 'other' } };
}

export function visibleNamespace(namespace: NamespaceJson, scope: WorkloadScope): boolean {
  if (scope.ownsCluster) return true;
  const name = namespace.metadata?.name ?? '';
  if (scope.apps.some((app) => app.mine && app.namespace === name)) return true;
  return namespace.metadata?.labels?.['koala.dev/owner'] === scope.viewerLabel;
}

const sumBy = (samples: readonly UsageSample[]): Map<string, number> => {
  const by = new Map<string, number>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) continue;
    const key = `${sample.namespace}/${sample.pod}`;
    by.set(key, (by.get(key) ?? 0) + sample.value);
  }
  return by;
};

export function clusterWorkloads(
  input: { pods: readonly PodJson[]; namespaces: readonly NamespaceJson[]; memory?: readonly UsageSample[] | undefined; cpu?: readonly UsageSample[] | undefined },
  scope: WorkloadScope,
  now: number,
): ClusterWorkloads {
  const labelsOf = new Map(input.namespaces.map((namespace) => [namespace.metadata?.name ?? '', namespace.metadata?.labels ?? {}]));
  const visible = new Set(input.namespaces.filter((namespace) => visibleNamespace(namespace, scope)).map((namespace) => namespace.metadata?.name ?? ''));
  const memory = input.memory ? sumBy(input.memory) : undefined;
  const cpu = input.cpu ? sumBy(input.cpu) : undefined;

  const grouped = new Map<string, { namespace: string; owner: { kind: WorkloadKind; name: string }; pods: PodJson[] }>();
  for (const pod of input.pods) {
    const namespace = pod.metadata?.namespace ?? '';
    if (!visible.has(namespace)) continue;
    const owner = ownerOf(pod);
    const key = `${namespace}/${owner.kind}/${owner.name}`;
    const entry = grouped.get(key) ?? { namespace, owner, pods: [] };
    entry.pods.push(pod);
    grouped.set(key, entry);
  }

  let finishedJobs = 0;
  const workloads: Workload[] = [];
  for (const { namespace, owner, pods } of grouped.values()) {
    const verdicts = pods.map((pod) => ({ pod, verdict: podVerdict(pod, now) }));
    if (owner.kind === 'Job' && verdicts.some(({ verdict }) => verdict.succeeded)) {
      finishedJobs += 1;
      continue;
    }
    const live = verdicts.filter(({ verdict }) => !verdict.failed);
    const failed = verdicts.filter(({ verdict }) => verdict.failed);
    const controlled = owner.kind === 'Deployment' || owner.kind === 'StatefulSet' || owner.kind === 'DaemonSet';
    let state: WorkloadState = 'ok';
    const reasons: string[] = [];
    for (const { verdict } of live) {
      state = worse(state, verdict.state);
      if (verdict.reason && !reasons.includes(verdict.reason)) reasons.push(verdict.reason);
    }
    if (failed.length) {
      const why = failed[0]!.verdict.reason ?? 'it stopped';
      if (controlled && live.some(({ verdict }) => verdict.ready)) {
        reasons.push(`${plural(failed.length, 'old pod')} failed and ${failed.length === 1 ? 'was' : 'were'} replaced: ${why}`);
      } else if (owner.kind === 'Job' && live.length > 0) {
        state = worse(state, 'warning');
        reasons.push(`${plural(failed.length, 'earlier try', 'earlier tries')} failed: ${why}`);
      } else {
        state = 'down';
        reasons.unshift(owner.kind === 'Job' ? `its job failed: ${why}` : why);
      }
    }
    if (controlled && live.length === 0 && failed.length === 0) state = worse(state, 'warning');

    const keys = pods.map((pod) => `${namespace}/${pod.metadata?.name ?? ''}`);
    const measure = (by: Map<string, number> | undefined): number | undefined => {
      if (!by) return undefined;
      const values = keys.map((key) => by.get(key)).filter((value): value is number => value !== undefined);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
    };
    const since = pods.map((pod) => pod.metadata?.creationTimestamp).filter((at): at is string => Boolean(at)).sort()[0];
    const release = pods.map(releaseOf).find(Boolean);
    workloads.push({
      namespace,
      kind: owner.kind,
      name: owner.name,
      ...aboutOf(namespace, owner.name, labelsOf.get(namespace) ?? {}, scope),
      ...(release ? { release } : {}),
      pods: { total: live.length, ready: live.filter(({ verdict }) => verdict.ready).length },
      state,
      reasons,
      restarts: verdicts.reduce((sum, { verdict }) => sum + verdict.restarts, 0),
      ...(measure(memory) !== undefined ? { memoryBytes: measure(memory) } : {}),
      ...(measure(cpu) !== undefined ? { cpuCores: measure(cpu) } : {}),
      ...(since ? { since } : {}),
    });
  }

  const GROUP_ORDER: WorkloadGroup[] = ['apps', 'koala', 'platform', 'other'];
  workloads.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
    || RANK[b.state] - RANK[a.state]
    || a.namespace.localeCompare(b.namespace)
    || a.name.localeCompare(b.name));
  return { workloads, finishedJobs, measured: Boolean(input.memory || input.cpu) };
}


export const brokenWorkloads = (workloads: readonly Workload[]): Workload[] => workloads.filter((workload) => workload.state === 'down' || workload.state === 'warning');
