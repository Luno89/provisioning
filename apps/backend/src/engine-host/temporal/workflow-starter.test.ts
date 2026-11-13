import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { WorkflowClient } from '@temporalio/client';
import { workFor } from '@koala/engine-core/work-for';
import { startedFor } from '../../platform/index.js';
import { temporalWorkflowStarter } from './workflow-starter.js';

describe('starting and signalling a run\'s workflow', () => {
  it('starts it as its owner\'s, as work for the project it names, and signals it by its workflow id', async () => {
    const client = mock<Pick<WorkflowClient, 'start' | 'getHandle'>>();
    let during: unknown;
    client.start.mockImplementation((async () => { during = workFor(); return { workflowId: 'run-1' }; }) as never);
    const handle = mock<ReturnType<WorkflowClient['getHandle']>>();
    client.getHandle.mockReturnValue(handle);
    const starter = temporalWorkflowStarter(client);

    expect(await starter.start('AgentRunWorkflow', { workflowId: 'run-1', taskQueue: 'engine', args: ['input'], owner: 'u1', project: 'p1', memo: { runId: 'run-1' } })).toEqual({ workflowId: 'run-1' });
    expect(client.start).toHaveBeenCalledWith('AgentRunWorkflow', { workflowId: 'run-1', taskQueue: 'engine', args: ['input'], memo: { runId: 'run-1' }, ...startedFor('u1') });
    expect(during).toEqual({ project: 'p1' });

    await starter.signal!('run-1', 'answer', { nodeId: 'n', value: 1 });
    await starter.signal!('run-1', 'cancelRun', undefined);
    expect(handle.signal.mock.calls).toEqual([['answer', { nodeId: 'n', value: 1 }], ['cancelRun']]);
  });
});
