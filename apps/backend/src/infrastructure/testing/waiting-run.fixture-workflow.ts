import { condition, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';

const runState = defineQuery<{ rounds: number; cancelled: boolean; asking: string[]; waitsFor: string[] }>('runState');
const cancelRun = defineSignal('cancelRun');

export async function AgentRunWorkflow(waitsFor: string[]): Promise<void> {
  let cancelled = false;
  setHandler(runState, () => ({ rounds: 0, cancelled, asking: [], waitsFor }));
  setHandler(cancelRun, () => { cancelled = true; });
  await condition(() => cancelled);
}
