
export type WorkloadHealth = 'healthy' | 'starting' | 'unhealthy' | 'unknown';

export interface WorkloadStatus {
  health: WorkloadHealth;
  reason: string;
}

const RESTARTS_BEFORE_FAILING = 3;

export const RECENT_RESTART_MS = 60 * 60_000;

const TERMINAL_WAITING = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
]);

const PULLING = new Set(['ImagePullBackOff', 'ErrImagePull']);

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

function pulled(container: ContainerLike): string {
  const message = container.state?.waiting?.message;
  if (!container.image) return message ? `: ${message}` : '';
  return `, its image ${container.image} could not be pulled${message ? `: ${message}` : ''}`;
}

function stuck(name: string, container: ContainerLike, now: number): WorkloadStatus | undefined {
  const waiting = container.state?.waiting?.reason;
  if (waiting && TERMINAL_WAITING.has(waiting)) return { health: 'unhealthy', reason: `${name}: ${waiting}${PULLING.has(waiting) ? pulled(container) : ''}` };
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
    const name = pod.metadata?.name ?? 'pod';
    const phase = pod.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    judged = true;

    for (const init of pod.status?.initContainerStatuses ?? []) {
      const failing = stuck(`${name} (init container ${init.name ?? 'unnamed'})`, init, now);
      if (failing) return failing;
    }

    const containers = pod.status?.containerStatuses ?? [];
    if (containers.length === 0) { starting = true; continue; }

    for (const c of containers) {
      const failing = stuck(name, c, now);
      if (failing) return failing;
      if (!c.ready) starting = true;
    }
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
