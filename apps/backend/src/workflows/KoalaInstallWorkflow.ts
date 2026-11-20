import { CancellationScope, condition, defineSignal, isCancellation, proxyActivities, setHandler } from '@temporalio/workflow';
import type { MachineProgress } from '@koala/engine-core/machine-progress';
import type { ProvisionReport } from '@koala/engine-core/koala-install';
import type * as installs from '../activities/KoalaInstallActivities.js';
import type { InstallAnswer, InstallHeard } from '../activities/KoalaInstallActivities.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { KOALA_INSTALL_SIGNALS } from '../instances/lib/koala-installs.js';

const steps = proxyActivities<Pick<typeof installs, 'KoalaInstallAskActivity' | 'KoalaInstallStageActivity' | 'KoalaInstallStoppedActivity'>>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export const progressHeard = defineSignal<[MachineProgress]>(KOALA_INSTALL_SIGNALS.progress);
export const setupHeard = defineSignal<[ProvisionReport]>(KOALA_INSTALL_SIGNALS.setup);
export const machineReconnected = defineSignal(KOALA_INSTALL_SIGNALS.reconnected);

type Ended = 'ready' | 'failed' | 'replaced';

const endingOf = (answer: InstallAnswer): Ended | undefined =>
  (answer === 'ready' || answer === 'failed' || answer === 'replaced' ? answer : undefined);

export async function KoalaInstallWorkflow(input: { installId: string }): Promise<Ended> {
  try {
    return await following(input);
  } catch (error) {
    if (!isCancellation(error)) throw error;
    await CancellationScope.nonCancellable(async () => { endingOf(await steps.KoalaInstallStoppedActivity(input)); });
    throw error;
  }
}

async function following(input: { installId: string }): Promise<Ended> {
  const heard: InstallHeard[] = [];
  let asks = 1;
  let asked = 0;
  setHandler(progressHeard, (progress) => { heard.push({ progress }); });
  setHandler(setupHeard, (setup) => { heard.push({ setup }); });
  setHandler(machineReconnected, () => { asks += 1; });
  for (;;) {
    if (asked < asks) {
      asked = asks;
      const ending = await CancellationScope.nonCancellable(async () => endingOf(await steps.KoalaInstallAskActivity(input)));
      if (ending) return ending;
    }
    while (heard.length > 0) {
      const ending = await CancellationScope.nonCancellable(async () => endingOf(await steps.KoalaInstallStageActivity({ installId: input.installId, ...heard.shift()! })));
      if (ending) return ending;
    }
    await condition(() => heard.length > 0 || asked < asks);
  }
}
