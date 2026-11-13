import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { WorkflowClient } from '@temporalio/client';
import { workFor } from '@koala/engine-core/work-for';
import { CONVERSATION_CONCLUSION_WORKFLOW, conversationConclusionId } from '../../engine-host/temporal/contracts.js';
import { startedFor } from '../../platform/index.js';
import { conversationConclusionTimer } from './conversation-timer.js';

describe('the countdown that concludes a conversation', () => {
  it('starts or tells the countdown for its conversation on the engine queue, with how long to stay quiet once a turn ends', async () => {
    const workflows = mock<Pick<WorkflowClient, 'signalWithStart'>>();
    const timer = conversationConclusionTimer({ workflows: async () => workflows, taskQueue: 'engine', projectOf: async () => undefined });
    await timer({ ownerId: 'u1', conversationId: 'c1', signal: 'turnEnded', quietMs: 600_000 });
    await timer({ ownerId: 'u1', conversationId: 'c1', signal: 'turnStarted' });
    const where = { workflowId: conversationConclusionId('c1'), taskQueue: 'engine', args: [{ ownerId: 'u1', conversationId: 'c1' }], ...startedFor('u1') };
    expect(workflows.signalWithStart.mock.calls).toEqual([
      [CONVERSATION_CONCLUSION_WORKFLOW, { ...where, signal: 'turnEnded', signalArgs: [{ quietMs: 600_000 }] }],
      [CONVERSATION_CONCLUSION_WORKFLOW, { ...where, signal: 'turnStarted', signalArgs: [] }],
    ]);
  });

  it('counts down a chat that works for a project as work for that project, so deleting the project fences what concluding it does', async () => {
    const workflows = mock<Pick<WorkflowClient, 'signalWithStart'>>();
    const seen: unknown[] = [];
    workflows.signalWithStart.mockImplementation((async () => { seen.push(workFor()); }) as never);
    const timer = conversationConclusionTimer({ workflows: async () => workflows, taskQueue: 'engine', projectOf: async (_ownerId, conversationId) => (conversationId === 'channel-p1' ? 'p1' : undefined) });
    await timer({ ownerId: 'u1', conversationId: 'channel-p1', signal: 'turnStarted' });
    await timer({ ownerId: 'u1', conversationId: 'c2', signal: 'turnStarted' });
    expect(seen).toEqual([{ project: 'p1' }, undefined]);
  });
});
