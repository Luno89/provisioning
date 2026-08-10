import { proxyActivities, sleep, ApplicationFailure, log } from '@temporalio/workflow';
import type { DeployAppArgs, DeployAppResult } from '../activities/DeployAppActivity.js';
import type { DownloadModelArgs } from '../activities/DownloadModelActivity.js';
import type { CheckWorkloadArgs, CheckWorkloadResult } from '../activities/CheckWorkloadActivity.js';
// From lib/activity-timeouts.ts, NOT from the activity files directly — importing a value (not
// just a type) from an activity file pulls its entire dependency tree (InfrastructureService,
// BuilderService, pino/pino-pretty, ...) into this workflow's webpack bundle, which Temporal's
// sandboxing can't handle (confirmed live: "UnhandledSchemeError" on node:stream/worker_threads).
import { deployAppActivityMeta, downloadModelActivityMeta, checkWorkloadActivityMeta } from '../lib/activity-timeouts.js';

// deployAppActivityMeta.startToCloseTimeout, not a hardcoded value here — this used to say '30
// minutes' regardless of what the activity itself declared (80 min), silently capping every
// deploy at 30 min no matter how generous the K8s-level timeouts (startupProbe,
// progressDeadlineSeconds, CDKTF's own timeouts) were set. Confirmed live: a TabbyAPI deploy
// with a slow model download needed more than 30 min and got killed here first.
const { DeployAppActivity } = proxyActivities<{ DeployAppActivity: (args: DeployAppArgs) => Promise<DeployAppResult> }>({ startToCloseTimeout: deployAppActivityMeta.startToCloseTimeout });
const { DownloadModelActivity } = proxyActivities<{ DownloadModelActivity: (args: DownloadModelArgs) => Promise<unknown> }>({ startToCloseTimeout: downloadModelActivityMeta.startToCloseTimeout });
const { CheckWorkloadActivity } = proxyActivities<{ CheckWorkloadActivity: (args: CheckWorkloadArgs) => Promise<CheckWorkloadResult> }>({ startToCloseTimeout: checkWorkloadActivityMeta.startToCloseTimeout });

/**
 * How long the workflow waits for the workload to come up before handing over to the background
 * reconciler.
 *
 * Generous, because a pod can legitimately take a very long time — this codebase already killed a
 * TabbyAPI deploy at thirty minutes while its model download was still going. The point of this
 * wait is to catch a deploy that has SETTLED into failing, not to put a shorter clock on success
 * than the deploy itself has.
 */
const ROLLOUT_CHECKS = 60;
const ROLLOUT_INTERVAL = '30 seconds';

/**
 * Waits for the applied workload to actually run.
 *
 * ── WHY THIS IS IN THE WORKFLOW ──
 * A deployment was marked `running` the moment the apply succeeded, which answers "did Terraform
 * finish", not "does the thing work". Observed on a real promote: `running` reported for six
 * minutes against a pod in CrashLoopBackOff.
 *
 * The waiting is durable timers rather than a long-lived activity, so a worker restart mid-rollout
 * resumes the wait instead of losing it — which matters precisely because the wait can be long.
 *
 * Three outcomes, and the third is the interesting one:
 *   · healthy   — return, and the deployment is marked running as usual.
 *   · unhealthy — throw, which is how a deploy is already reported failed. Non-retryable: re-running
 *                 an apply does not fix a container that exits on startup, and retrying would just
 *                 spend another eighty minutes proving it.
 *   · still starting when the budget runs out — return anyway. A slow deploy is not a failed one,
 *     and the background reconciler keeps watching it. Failing here would repeat the exact mistake
 *     that once capped every deploy at thirty minutes.
 */
async function awaitWorkload(name: string, clusterId: string): Promise<void> {
  for (let i = 0; i < ROLLOUT_CHECKS; i++) {
    await sleep(ROLLOUT_INTERVAL);
    const { health, reason } = await CheckWorkloadActivity({ name, clusterId });

    if (health === 'healthy') {
      log.info(`Workload for ${name} is running`);
      return;
    }
    if (health === 'unhealthy') {
      throw ApplicationFailure.create({
        message: `The deployment applied, but its workload is not running: ${reason}`,
        nonRetryable: true,
      });
    }
    // `starting` and `unknown` both mean "no verdict yet" — keep waiting.
  }
  log.warn(`Workload for ${name} had not started within the rollout window; leaving it to the reconciler`);
}

export async function executeDeployAppWorkflow(args: DeployAppArgs) {
  // Pre-download step: only runs when TemporalBridge.deploy() determined this deploy targets a
  // cluster where the worker actually shares a filesystem with the K8s node (see
  // DownloadModelActivity.ts's own comment for why that's currently just the native-k3s system
  // cluster) — modelCacheHostPath is left unset for every other case, and the pod's own
  // in-container download logic (unchanged) is the fallback there.
  if (args.appType === 'tabbyapi' && args.modelCacheHostPath && args.tabbyModel) {
    await DownloadModelActivity({
      modelRepo: args.tabbyModel,
      revision: args.tabbyRevision,
      hfToken: args.tabbyHfToken,
      cacheHostPath: args.modelCacheHostPath,
    });
  }
  const result = await DeployAppActivity(args);
  // Only after the apply: there is nothing to watch before it.
  await awaitWorkload(args.name, args.clusterId);
  return result;
}
