/**
 * Whether a deployed workload is actually running, as opposed to having been successfully applied.
 *
 * ── THE GAP THIS FILLS ──
 * A deployment is marked `running` when the CDKTF apply succeeds. For most app types that already
 * means something — Terraform waits for the rollout — but it is a verdict delivered once, at apply
 * time, and never revisited. A workload that dies afterwards keeps its `running` record forever.
 *
 * And one app type never got even that: `constructs/gitapp.ts` must set `waitForRollout: false` to
 * avoid a deadlock with its imagePullSecret, so its apply returns before any pod has started. That
 * is the app type the agent builds. Observed on the first promote-to-staging: `running` reported for
 * six minutes while the pod sat in CrashLoopBackOff with four restarts, and the only way to find out
 * was `kubectl`.
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
  /**
   * Whether any pod here was actually judged.
   *
   * Without this, a namespace whose pods were ALL skipped fell through to `healthy` — the loop
   * simply never set `starting`. A namespace containing nothing but a completed Job would report a
   * healthy workload while running nothing at all, which is the exact false reassurance this
   * module exists to remove.
   */
  let judged = false;

  for (const pod of items) {
    const name = pod.metadata?.name ?? 'pod';
    const phase = pod.status?.phase;
    // A finished Job's pod is not a sick Deployment. Neither state says anything about health.
    if (phase === 'Succeeded') continue;
    judged = true;

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

  if (starting) return { health: 'starting', reason: 'containers not ready yet' };
  // Nothing left to judge means no long-running workload was found, not a healthy one. `starting`
  // rather than `unhealthy`: a namespace mid-rollout looks exactly like this for a moment.
  if (!judged) return { health: 'starting', reason: 'no running workload yet' };
  return { health: 'healthy', reason: '' };
}

/**
 * What the deployment record should say, given what the cluster shows.
 *
 * ── THE TWO STATES THIS OWNS ──
 * Only `running` and `unhealthy`, and only on a settled verdict. Everything else belongs to
 * someone else:
 *
 *   · `deploying` / `destroying` belong to the workflow that is mid-flight. Relabelling one from
 *     outside would race the thing doing the work.
 *   · `failed` belongs to the deploy that failed. A deploy that never completed is a fact about
 *     history, and no amount of later pod-watching makes it untrue — only a new deploy clears it.
 *     Letting this function flip `failed` to `running` would erase the record of a broken deploy
 *     because something unrelated in the namespace happened to look healthy.
 */
export function reconciledStatus(
  current: string,
  health: WorkloadHealth,
): 'running' | 'unhealthy' | undefined {
  if (current !== 'running' && current !== 'unhealthy') return undefined;
  if (health === 'unhealthy' && current !== 'unhealthy') return 'unhealthy';
  /**
   * Recovery counts too.
   *
   * A workload fixed by a later deploy, or one that finally pulled its image, would otherwise stay
   * marked unhealthy forever — and a status that only ever gets worse is one people learn to ignore.
   */
  if (health === 'healthy' && current !== 'running') return 'running';
  return undefined;
}
