import { condition, defineSignal, getExternalWorkflowHandle, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as pool from '../activities/PoolActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { MOVE_FINISHED, MOVE_STOPPED } from '../instances/lib/instance-move.js';
import { poolTrialWorkflowId, TRIAL_CHANGED } from '../instances/lib/pool-trial.js';

const moving = proxyActivities<Pick<typeof pool, 'PoolMoveStartActivity' | 'PoolMoveSwitchActivity' | 'PoolMoveStopActivity'>>({ ...LIVE_ACTIVITY, retry: { maximumAttempts: 10 } });

export const moveFinished = defineSignal(MOVE_FINISHED);
export const moveStopped = defineSignal<[string]>(MOVE_STOPPED);

export async function PoolMoveWorkflow(input: { instanceId: string }): Promise<'moved' | 'stopped'> {
  let outcome: { finished: true } | { stopped: string } | undefined;
  setHandler(moveFinished, () => { outcome ??= { finished: true }; });
  setHandler(moveStopped, (reason) => { outcome ??= { stopped: reason }; });
  const trial = getExternalWorkflowHandle(poolTrialWorkflowId(input.instanceId));
  await trial.signal(TRIAL_CHANGED).catch(() => undefined);
  await moving.PoolMoveStartActivity(input);
  await condition(() => outcome !== undefined);
  const settled = outcome!;
  if ('finished' in settled) await moving.PoolMoveSwitchActivity(input);
  else await moving.PoolMoveStopActivity({ instanceId: input.instanceId, reason: settled.stopped });
  await trial.signal(TRIAL_CHANGED).catch(() => undefined);
  return 'finished' in settled ? 'moved' : 'stopped';
}
