/**
 * Waiting for an applied workload to actually run.
 *
 * ── WHAT ACTUALLY NEEDED THIS ──
 * Terraform's `kubernetes_deployment` waits for the rollout itself (`wait_for_rollout` defaults to
 * true), so for eighteen of the nineteen constructs a broken workload already fails the apply. This
 * is NOT a missing check across the board, and describing it that way was wrong.
 *
 * The exception is the one that matters: `constructs/gitapp.ts` sets `waitForRollout: false`, and
 * has to — its imagePullSecret is created after the apply returns, so waiting would deadlock. That
 * is the app type the agent builds and promotes, and it was the only one where "deployed" meant
 * "manifest applied". Measured on the first promote-to-staging: `running` for six minutes against a
 * pod in CrashLoopBackOff.
 *
 * The second gap applies to every type: the apply's wait ends when the apply does. A workload that
 * goes bad an hour later — OOM, a crash on first real traffic, an evicted node — was nobody's job
 * to notice. That is what the background reconciler covers; this covers the rollout itself.
 *
 * Applied to all three workflows that change what a pod is running rather than to gitapp alone,
 * because the cost on a type that already waited is one extra check against a pod Terraform just
 * confirmed was Available, and a per-app-type exception list is the kind of thing that goes stale
 * silently.
 *
 * ── WHY THE WAIT IS IN THE WORKFLOW ──
 * A pod can take a very long time to come up. This codebase already learned that expensively: a
 * TabbyAPI deploy downloading a model needed more than thirty minutes and a hardcoded timeout killed
 * it first. So the waiting is durable timers rather than a long-lived activity — a worker restart
 * mid-rollout resumes the wait instead of losing it, which matters precisely because it can be long.
 *
 * ── WHY THIS RETURNS RATHER THAN THROWS ──
 * "The apply worked and the container crashes on startup" is not the same event as "the apply
 * failed", and collapsing them loses the only fact that tells you where to look. The workflow
 * completes and reports the verdict; the caller decides what to record.
 */
import { proxyActivities, sleep, log } from '@temporalio/workflow';
import type { CheckWorkloadArgs, CheckWorkloadResult } from '../activities/CheckWorkloadActivity.js';
// From lib/activity-timeouts.ts, NOT the activity file directly — importing a value from an
// activity file pulls its whole dependency tree into the workflow bundle, which Temporal's
// sandboxing can't handle. See AppDeployWorkflow.ts.
import { checkWorkloadActivityMeta } from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { CheckWorkloadActivity } = proxyActivities<{
  CheckWorkloadActivity: (args: CheckWorkloadArgs) => Promise<CheckWorkloadResult>;
}>({ retry: ACTIVITY_RETRY, startToCloseTimeout: checkWorkloadActivityMeta.startToCloseTimeout });

/**
 * Generous on purpose. The point is to catch a workload that has SETTLED into failing, not to put a
 * shorter clock on success than the deploy itself has (the deploy activity allows 80 minutes).
 */
const ROLLOUT_CHECKS = 60;
const ROLLOUT_INTERVAL = '30 seconds';

export interface WorkloadVerdict {
  /**
   * `starting` here means the budget ran out with the workload still on its way up — a slow deploy,
   * not a failed one. The background reconciler keeps watching it, and failing on this would repeat
   * the mistake that once capped every deploy at thirty minutes.
   */
  workload: 'healthy' | 'unhealthy' | 'starting';
  workloadReason: string;
}

export async function awaitWorkload(name: string, clusterId: string): Promise<WorkloadVerdict> {
  for (let i = 0; i < ROLLOUT_CHECKS; i++) {
    /**
     * Checked BEFORE the first sleep, not after.
     *
     * Most app types reach here having already waited for the rollout inside the apply, so the pod
     * is Available the moment this runs and the answer is immediate. Sleeping first would add
     * thirty seconds to every successful deploy on the platform to re-confirm something Terraform
     * just confirmed. Measured: that is exactly what the first version did.
     *
     * Checking early is safe because "no pods yet" is a `starting` verdict, not a failure.
     */
    const { health, reason } = await CheckWorkloadActivity({ name, clusterId });

    if (health === 'healthy') {
      log.info(`Workload for ${name} is running`);
      return { workload: 'healthy', workloadReason: '' };
    }
    if (health === 'unhealthy') {
      /**
       * The Kubernetes objects are deliberately left in place.
       *
       * A crashlooping pod's logs and events are the only thing that explains why it crashed, and
       * tearing it down to leave a tidy cluster would delete the evidence at exactly the moment
       * someone needs it. The deployment is recorded `unhealthy` rather than removed, so it stays
       * visible on the board — and destroying it is one click, whenever the user is done looking.
       */
      log.warn(`Workload for ${name} is not running: ${reason}`);
      return { workload: 'unhealthy', workloadReason: reason };
    }
    // `starting` and `unknown` both mean "no verdict yet" — wait and look again.
    await sleep(ROLLOUT_INTERVAL);
  }
  log.warn(`Workload for ${name} had not started within the rollout window; leaving it to the reconciler`);
  return { workload: 'starting', workloadReason: 'still starting when the rollout window ended' };
}
