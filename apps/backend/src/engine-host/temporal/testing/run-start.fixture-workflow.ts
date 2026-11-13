import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

const { SeenActivity } = proxyActivities<{ SeenActivity(): Promise<unknown> }>({ startToCloseTimeout: '1 minute' });

export const answer = defineSignal<[unknown]>('answer');
export const approve = defineSignal<[unknown]>('approve');
export const cancelRun = defineSignal<[{ by?: string } | undefined]>('cancelRun');

export async function AgentRunWorkflow(): Promise<{ seen: unknown; answered: unknown; approved: unknown; cancelledBy: unknown }> {
  let answered: unknown;
  let approved: unknown;
  let cancelledBy: unknown;
  setHandler(answer, (value) => { answered = value; });
  setHandler(approve, (value) => { approved = value; });
  setHandler(cancelRun, (value) => { cancelledBy = value?.by; });
  await condition(() => answered !== undefined && approved !== undefined && cancelledBy !== undefined);
  return { seen: await SeenActivity(), answered, approved, cancelledBy };
}
