import { ActivityFailure, ApplicationFailure, isCancellation, proxyActivities } from '@temporalio/workflow';
import type { ProvisionPieceResult } from '../infrastructure/index.js';
import type { ProvisionPieceRun } from '../activities/ProvisionPieceActivity.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { startMachineCluster, stopMachineClusterWhenIdle } from './machine-cluster.js';
import type { ProvisionPieceArgs } from './provision-piece.js';

const { ProvisionPieceActivity } = proxyActivities<{ ProvisionPieceActivity(run: ProvisionPieceRun): Promise<void> }>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

function whyOf(err: ActivityFailure | ApplicationFailure): string {
  const failure = err instanceof ActivityFailure && err.cause ? err.cause : err;
  return failure.message;
}

async function applied(args: ProvisionPieceArgs): Promise<void> {
  const { machine, ...run } = args;
  if (run.target.kind !== 'machine' || !machine) return ProvisionPieceActivity(run);
  const kubeconfig = await startMachineCluster(machine, run.target.clusterId);
  try {
    await ProvisionPieceActivity({ ...run, kubeconfig });
  } finally {
    await stopMachineClusterWhenIdle(machine, run.target.clusterId);
  }
}

export async function ProvisionPieceWorkflow(args: ProvisionPieceArgs): Promise<ProvisionPieceResult> {
  try {
    await applied(args);
    return { ok: true };
  } catch (err) {
    if (isCancellation(err)) throw err;
    if (err instanceof ActivityFailure || err instanceof ApplicationFailure) return { ok: false, why: whyOf(err) };
    throw err;
  }
}
