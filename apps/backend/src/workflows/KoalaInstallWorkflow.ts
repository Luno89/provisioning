import { condition, defineSignal, getExternalWorkflowHandle, proxyActivities, setHandler } from '@temporalio/workflow';
import type { MachineProgress } from '@koala/engine-core/machine-progress';
import type { ProvisionReport } from '@koala/engine-core/koala-install';
import { ignore } from '@koala/engine-core/failures';
import type * as installs from '../activities/KoalaInstallActivities.js';
import type { InstallAnswer, InstallHeard } from '../activities/KoalaInstallActivities.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { KOALA_INSTALL_SIGNALS } from '../instances/lib/koala-installs.js';
import { MOVE_FINISHED, MOVE_STOPPED, poolMoveWorkflowId } from '../instances/lib/instance-move.js';

const steps = proxyActivities<Pick<typeof installs, 'KoalaInstallAskActivity' | 'KoalaInstallStageActivity'>>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export const progressHeard = defineSignal<[MachineProgress]>(KOALA_INSTALL_SIGNALS.progress);
export const setupHeard = defineSignal<[ProvisionReport]>(KOALA_INSTALL_SIGNALS.setup);
export const machineReconnected = defineSignal(KOALA_INSTALL_SIGNALS.reconnected);

type Ended = 'ready' | 'failed' | 'replaced';

async function endingOf(answer: InstallAnswer): Promise<Ended | undefined> {
  if (typeof answer === 'object') {
    const move = getExternalWorkflowHandle(poolMoveWorkflowId(answer.instanceId));
    const told = answer.ended === 'ready' ? move.signal(MOVE_FINISHED) : move.signal(MOVE_STOPPED, answer.why ?? 'the move stopped on your machine');
    await told.catch(ignore('a move that has already ended has nothing left to switch or stop'));
    return answer.ended;
  }
  return answer === 'ready' || answer === 'failed' || answer === 'replaced' ? answer : undefined;
}

export async function KoalaInstallWorkflow(input: { installId: string }): Promise<Ended> {
  const heard: InstallHeard[] = [];
  let asks = 1;
  let asked = 0;
  setHandler(progressHeard, (progress) => { heard.push({ progress }); });
  setHandler(setupHeard, (setup) => { heard.push({ setup }); });
  setHandler(machineReconnected, () => { asks += 1; });
  for (;;) {
    if (asked < asks) {
      asked = asks;
      const ending = await endingOf(await steps.KoalaInstallAskActivity(input));
      if (ending) return ending;
    }
    while (heard.length > 0) {
      const ending = await endingOf(await steps.KoalaInstallStageActivity({ installId: input.installId, ...heard.shift()! }));
      if (ending) return ending;
    }
    await condition(() => heard.length > 0 || asked < asks);
  }
}
