import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import { DEFAULT_STREAM_TASK_QUEUE, type LifecycleEvent } from '../engine-host/temporal/contracts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

export const turnStartedSignal = defineSignal('turnStarted');
export const turnEndedSignal = defineSignal<[{ quietMs: number }]>('turnEnded');

const { EngineLifecycleActivity } = proxyActivities<{ EngineLifecycleActivity(event: LifecycleEvent): Promise<void> }>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '1 minute',
});

export async function ConversationConclusionWorkflow(input: { ownerId: string; conversationId: string }): Promise<void> {
  let busy = false;
  let quietMs = 0;
  let changes = 0;
  setHandler(turnStartedSignal, () => { busy = true; changes += 1; });
  setHandler(turnEndedSignal, ({ quietMs: after }) => { busy = false; quietMs = after; changes += 1; });

  for (;;) {
    await condition(() => !busy && quietMs > 0);
    const seen = changes;
    if (await condition(() => changes !== seen, quietMs)) continue;
    await EngineLifecycleActivity({ kind: 'conversation-quiet', ownerId: input.ownerId, conversationId: input.conversationId });
    return;
  }
}
