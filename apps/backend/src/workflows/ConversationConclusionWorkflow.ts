import { condition, defineSignal, executeChild, patched, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { ConcludeWorkspaceWorkflow } from './ConcludeWorkspaceWorkflow.js';
import { DEFAULT_STREAM_TASK_QUEUE, concludeWorkspaceId, type ConcludedWorkspace, type LifecycleEvent } from '../engine-host/temporal/contracts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import { ownerIn, startedFor } from '../lib/workflow-owner.js';

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
    if (patched('conclude-workspace')) await concludeWorkspace(input.ownerId, { kind: 'conversation', id: input.conversationId });
    return;
  }
}

async function concludeWorkspace(ownerId: string, workspace: ConcludedWorkspace): Promise<void> {
  try {
    await executeChild(ConcludeWorkspaceWorkflow, { workflowId: concludeWorkspaceId(workspace), args: [{ ownerId, workspace }], ...startedFor(ownerIn(workflowInfo().typedSearchAttributes) ?? ownerId) });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
}
