import { proxyActivities } from '@temporalio/workflow';
import type { DeployAppArgs } from '../activities/DeployAppActivity.js';
import type { DownloadModelArgs } from '../activities/DownloadModelActivity.js';
// From lib/activity-timeouts.ts, NOT from the activity files directly — importing a value (not
// just a type) from an activity file pulls its entire dependency tree (InfrastructureService,
// BuilderService, pino/pino-pretty, ...) into this workflow's webpack bundle, which Temporal's
// sandboxing can't handle (confirmed live: "UnhandledSchemeError" on node:stream/worker_threads).
import { deployAppActivityMeta, downloadModelActivityMeta } from '../lib/activity-timeouts.js';

// deployAppActivityMeta.startToCloseTimeout, not a hardcoded value here — this used to say '30
// minutes' regardless of what the activity itself declared (80 min), silently capping every
// deploy at 30 min no matter how generous the K8s-level timeouts (startupProbe,
// progressDeadlineSeconds, CDKTF's own timeouts) were set. Confirmed live: a TabbyAPI deploy
// with a slow model download needed more than 30 min and got killed here first.
const { DeployAppActivity } = proxyActivities<{ DeployAppActivity: DeployAppArgs }>({ startToCloseTimeout: deployAppActivityMeta.startToCloseTimeout });
const { DownloadModelActivity } = proxyActivities<{ DownloadModelActivity: (args: DownloadModelArgs) => Promise<unknown> }>({ startToCloseTimeout: downloadModelActivityMeta.startToCloseTimeout });

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
  return DeployAppActivity(args);
}
