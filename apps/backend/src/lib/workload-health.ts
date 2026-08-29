
export type WorkloadHealth = 'healthy' | 'starting' | 'unhealthy' | 'unknown';

export interface WorkloadStatus {
  health: WorkloadHealth;
  reason: string;
}

const RESTARTS_BEFORE_FAILING = 3;

const TERMINAL_WAITING = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
]);

interface PodLike {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    containerStatuses?: {
      ready?: boolean;
      restartCount?: number;
      state?: { waiting?: { reason?: string }; terminated?: { reason?: string; exitCode?: number } };
    }[];
  };
}

export function assessWorkload(podListJson: unknown): WorkloadStatus {
  const items = (podListJson as { items?: PodLike[] })?.items;
  if (!Array.isArray(items)) return { health: 'unknown', reason: '' };
  if (items.length === 0) return { health: 'starting', reason: 'no pods yet' };

  let starting = false;
  let judged = false;

  for (const pod of items) {
    const name = pod.metadata?.name ?? 'pod';
    const phase = pod.status?.phase;
    if (phase === 'Succeeded') continue;
    judged = true;

    const containers = pod.status?.containerStatuses ?? [];
    if (containers.length === 0) { starting = true; continue; }

    for (const c of containers) {
      const waiting = c.state?.waiting?.reason;
      if (waiting && TERMINAL_WAITING.has(waiting)) {
        return { health: 'unhealthy', reason: `${name}: ${waiting}` };
      }
      if ((c.restartCount ?? 0) >= RESTARTS_BEFORE_FAILING && !c.ready) {
        return { health: 'unhealthy', reason: `${name}: restarted ${c.restartCount} times` };
      }
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
