
export type WorkloadHealth = 'healthy' | 'starting' | 'unhealthy' | 'unknown';

export interface WorkloadStatus {
  health: WorkloadHealth;
  reason: string;
}

const RESTARTS_BEFORE_FAILING = 3;

export const RECENT_RESTART_MS = 60 * 60_000;

const REFUSED = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
]);

const PULLING = new Set(['ImagePullBackOff', 'ErrImagePull']);

const TOLD_WHY = new Set(['CreateContainerError']);

interface ContainerLike {
  name?: string;
  image?: string;
  ready?: boolean;
  restartCount?: number;
  state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string; exitCode?: number } };
  lastState?: { terminated?: { finishedAt?: string } };
}

interface PodLike {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    initContainerStatuses?: ContainerLike[];
    containerStatuses?: ContainerLike[];
  };
}

export type Trouble =
  | { kind: 'refused'; reason: string }
  | { kind: 'crashing'; name: string; reason: string; exitedAt: number };

function pulled(container: ContainerLike): string {
  const message = container.state?.waiting?.message;
  if (!container.image) return message ? `: ${message}` : '';
  return `, its image ${container.image} could not be pulled${message ? `: ${message}` : ''}`;
}

const told = (waiting: string, container: ContainerLike): string => {
  const message = container.state?.waiting?.message;
  return TOLD_WHY.has(waiting) && message ? `: ${message}` : '';
};

function troubleOf(name: string, container: ContainerLike): Trouble | undefined {
  const waiting = container.state?.waiting?.reason;
  if (waiting === 'CrashLoopBackOff') return { kind: 'crashing', name, reason: `${name}: ${waiting}`, exitedAt: Date.parse(container.lastState?.terminated?.finishedAt ?? '') };
  if (waiting && REFUSED.has(waiting)) return { kind: 'refused', reason: `${name}: ${waiting}${PULLING.has(waiting) ? pulled(container) : told(waiting, container)}` };
  return undefined;
}

const ended = (pod: PodLike): boolean => pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed';

function containersOf(pod: PodLike): { name: string; container: ContainerLike }[] {
  const name = pod.metadata?.name ?? 'pod';
  return [
    ...(pod.status?.initContainerStatuses ?? []).map((container) => ({ name: `${name} (init container ${container.name ?? 'unnamed'})`, container })),
    ...(pod.status?.containerStatuses ?? []).map((container) => ({ name, container })),
  ];
}

export function podTroubles(pods: readonly unknown[]): Trouble[] {
  return (pods as PodLike[]).filter((pod) => !ended(pod)).flatMap((pod) => containersOf(pod).flatMap(({ name, container }) => {
    const trouble = troubleOf(name, container);
    return trouble ? [trouble] : [];
  }));
}

function stuck(name: string, container: ContainerLike, now: number): WorkloadStatus | undefined {
  const trouble = troubleOf(name, container);
  if (trouble) return { health: 'unhealthy', reason: trouble.reason };
  const lastRestart = Date.parse(container.lastState?.terminated?.finishedAt ?? '');
  const restartedLately = Number.isFinite(lastRestart) && now - lastRestart < RECENT_RESTART_MS;
  if ((container.restartCount ?? 0) >= RESTARTS_BEFORE_FAILING && !container.ready && restartedLately) {
    return { health: 'unhealthy', reason: `${name}: restarted ${container.restartCount} times` };
  }
  return undefined;
}

export function assessWorkload(podListJson: unknown, now: number = Date.now()): WorkloadStatus {
  const items = (podListJson as { items?: PodLike[] })?.items;
  if (!Array.isArray(items)) return { health: 'unknown', reason: '' };
  if (items.length === 0) return { health: 'starting', reason: 'no pods yet' };

  let starting = false;
  let judged = false;

  for (const pod of items) {
    if (ended(pod)) continue;
    judged = true;

    for (const { name, container } of containersOf(pod)) {
      const failing = stuck(name, container, now);
      if (failing) return failing;
    }

    const containers = pod.status?.containerStatuses ?? [];
    if (containers.length === 0 || containers.some((c) => !c.ready)) starting = true;
  }

  if (starting) return { health: 'starting', reason: 'containers not ready yet' };
  if (!judged) return { health: 'starting', reason: 'no running workload yet' };
  return { health: 'healthy', reason: '' };
}

export function reconciledStatus(
  current: string,
  health: WorkloadHealth,
): 'running' | 'unhealthy' | undefined {
  if (current !== 'running' && current !== 'unhealthy') return undefined;
  if (health === 'unhealthy' && current !== 'unhealthy') return 'unhealthy';
  if (health === 'healthy' && current !== 'running') return 'running';
  return undefined;
}
