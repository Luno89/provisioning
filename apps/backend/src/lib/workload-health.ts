/**
 * Whether a deployed workload is actually running, as opposed to having been successfully applied.
 *
 * ── THE GAP THIS FILLS ──
 * A deployment is marked `running` when the CDKTF apply succeeds. Nothing has ever looked at the
 * pod afterwards. Observed on the first promote-to-staging: the platform reported `running` for six
 * minutes while the pod sat in CrashLoopBackOff with four restarts, and nothing would ever have
 * reconciled the two — the only way to find out was `kubectl`.
 *
 * That is the deployment-level version of the failure this codebase keeps producing: a record that
 * says success while reality disagrees, discoverable only by someone who knows where to look.
 *
 * ── WHY THIS IS NOT JUST "IS IT READY" ──
 * A workload that has been up for two seconds is not unhealthy, it is starting. Image pulls take
 * time, containers boot, and a check that flipped a deployment to `failed` the moment a pod was
 * briefly unready would cry wolf on every single deploy — which is worse than the silence it
 * replaces, because a warning nobody believes is one nobody reads.
 *
 * So `starting` is a real answer, and only a workload that has settled into failing is called
 * failed.
 */

export type WorkloadHealth = 'healthy' | 'starting' | 'unhealthy' | 'unknown';

export interface WorkloadStatus {
  health: WorkloadHealth;
  /** Human-readable, for the deployment record and the log. Empty when healthy. */
  reason: string;
}

/** Restarts before a workload counts as settled-into-failing rather than still finding its feet. */
const RESTARTS_BEFORE_FAILING = 3;

/**
 * Container states that mean "this will not fix itself".
 *
 * `CrashLoopBackOff` is the settled form of a container that keeps exiting; the image-pull failures
 * are configuration errors that no amount of waiting resolves. Everything else — `ContainerCreating`,
 * `PodInitializing`, a plain `Pending` — is a workload still on its way up.
 */
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

/**
 * Reads `kubectl get pods -o json` for one namespace.
 *
 * Pure so the decision can be tested against the exact shapes Kubernetes produces, rather than only
 * against a cluster that happens to be misbehaving at the time.
 */
export function assessWorkload(podListJson: unknown): WorkloadStatus {
  const items = (podListJson as { items?: PodLike[] })?.items;
  // No pods at all. Not "unhealthy" — a namespace can be mid-apply, and calling that a failure
  // would flag every deploy in its first seconds.
  if (!Array.isArray(items)) return { health: 'unknown', reason: '' };
  if (items.length === 0) return { health: 'starting', reason: 'no pods yet' };

  let starting = false;

  for (const pod of items) {
    const name = pod.metadata?.name ?? 'pod';
    const phase = pod.status?.phase;
    // A finished Job's pod is not a sick Deployment. Neither state says anything about health.
    if (phase === 'Succeeded') continue;

    const containers = pod.status?.containerStatuses ?? [];
    // Scheduled but no container status yet: still coming up.
    if (containers.length === 0) { starting = true; continue; }

    for (const c of containers) {
      const waiting = c.state?.waiting?.reason;
      if (waiting && TERMINAL_WAITING.has(waiting)) {
        return { health: 'unhealthy', reason: `${name}: ${waiting}` };
      }
      /**
       * Restarting repeatedly without reaching the backoff state yet.
       *
       * A container that exits immediately churns through several restarts before Kubernetes
       * declares CrashLoopBackOff, and during that window it looks merely "not ready".
       */
      if ((c.restartCount ?? 0) >= RESTARTS_BEFORE_FAILING && !c.ready) {
        return { health: 'unhealthy', reason: `${name}: restarted ${c.restartCount} times` };
      }
      if (!c.ready) starting = true;
    }
  }

  return starting ? { health: 'starting', reason: 'containers not ready yet' } : { health: 'healthy', reason: '' };
}

/**
 * What the deployment record should say, given what the cluster shows.
 *
 * Only ever moves a deployment between `running` and `failed`, and only on a settled verdict.
 * `deploying` and `destroying` belong to the workflow that is mid-flight — reaching in and
 * relabelling one from outside would race the thing doing the work.
 */
export function reconciledStatus(
  current: string,
  health: WorkloadHealth,
): 'running' | 'failed' | undefined {
  if (current !== 'running' && current !== 'failed') return undefined;
  if (health === 'unhealthy' && current !== 'failed') return 'failed';
  /**
   * Recovery counts too.
   *
   * A workload fixed by a later deploy, or one that finally pulled its image, would otherwise stay
   * marked failed forever — and a status that only ever gets worse is one people learn to ignore.
   */
  if (health === 'healthy' && current !== 'running') return 'running';
  return undefined;
}
