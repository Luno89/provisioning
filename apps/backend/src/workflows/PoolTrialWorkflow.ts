import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as pool from '../activities/PoolActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { TRIAL_CHANGED } from '../instances/lib/pool-trial.js';

const trial = proxyActivities<Pick<typeof pool, 'PoolTrialNextActivity' | 'PoolTrialStepActivity'>>({ ...LIVE_ACTIVITY, retry: { maximumAttempts: 20 } });

export const trialChanged = defineSignal(TRIAL_CHANGED);

export async function PoolTrialWorkflow(input: { instanceId: string }): Promise<void> {
  let changed = false;
  setHandler(trialChanged, () => { changed = true; });
  for (;;) {
    changed = false;
    const due = await trial.PoolTrialNextActivity({ instanceId: input.instanceId, now: Date.now() });
    if (!due) return;
    if ('hold' in due) {
      await condition(() => changed);
      continue;
    }
    const wait = due.at - Date.now();
    if (wait > 0 && await condition(() => changed, wait)) continue;
    if (changed) continue;
    await trial.PoolTrialStepActivity({ instanceId: input.instanceId, step: due.step, now: Date.now() });
    if (due.step === 'delete') return;
  }
}
