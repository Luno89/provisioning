import { condition, defineSignal, setHandler } from '@temporalio/workflow';

const cancelRun = defineSignal('cancelRun');

export async function provisionStandIn(): Promise<void> {
  let stopped = false;
  setHandler(cancelRun, () => { stopped = true; });
  await condition(() => stopped);
}
