import type { WorkflowClient } from '@temporalio/client';
import { withWorkFor } from '@koala/engine-core/work-for';
import { CONVERSATION_CONCLUSION_WORKFLOW, conversationConclusionId } from '../../engine-host/temporal/contracts.js';
import { startedFor } from '../../platform/index.js';
import type { ConversationTimer } from './MemoryKeeperService.js';

export interface ConversationTimerDeps {
  workflows: () => Promise<Pick<WorkflowClient, 'signalWithStart'>>;
  taskQueue: string;
  projectOf: (ownerId: string, conversationId: string) => Promise<string | undefined>;
}

export const conversationConclusionTimer = (deps: ConversationTimerDeps): ConversationTimer => async ({ ownerId, conversationId, signal, quietMs }) => {
  const workflows = await deps.workflows();
  const where = {
    workflowId: conversationConclusionId(conversationId),
    taskQueue: deps.taskQueue,
    args: [{ ownerId, conversationId }],
    ...startedFor(ownerId),
  };
  await withWorkFor({ project: await deps.projectOf(ownerId, conversationId) }, () => (signal === 'turnEnded'
    ? workflows.signalWithStart(CONVERSATION_CONCLUSION_WORKFLOW, { ...where, signal, signalArgs: [{ quietMs: quietMs ?? 0 }] })
    : workflows.signalWithStart(CONVERSATION_CONCLUSION_WORKFLOW, { ...where, signal, signalArgs: [] })));
};
