import { workFor } from '@koala/engine-core/work-for';
import { ApplicationFailure, WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { CONCLUDE_WORKSPACE_WORKFLOW, concludeWorkspaceId } from '../../engine-host/temporal/contracts.js';
import type { SavedDocuments } from '../../engine-host/sandboxes/workspace-documents.js';
import { startedFor } from '../../platform/index.js';
import { WorkspaceConclusionService, WorkspaceNotConcludedError, type ConclusionWorkflows } from './WorkspaceConclusionService.js';

type Handle = ReturnType<ConclusionWorkflows['getHandle']>;

const saved = { saved: true, owner: 'koala-u1', repo: 'tree-t1', commit: 'c0ffee' } as SavedDocuments;

let workflows: MockProxy<ConclusionWorkflows>;
let handle: MockProxy<Handle>;
let service: WorkspaceConclusionService;

beforeEach(() => {
  workflows = mock<ConclusionWorkflows>();
  handle = mock<Handle>();
  workflows.start.mockResolvedValue(undefined);
  workflows.getHandle.mockReturnValue(handle);
  handle.result.mockResolvedValue(saved);
  service = new WorkspaceConclusionService({ workflows: async () => workflows, taskQueue: 'engine-queue', projectOf: async (_ownerId, workspace) => (workspace.id === 't1' ? 'p1' : undefined) });
});

describe('concluding a workspace', () => {
  it('concludes a workspace whose tree or chat works for a project as work for that project, so deleting the project fences it', async () => {
    const seen: unknown[] = [];
    workflows.start.mockImplementation(async () => { seen.push(workFor()); });
    await service.conclude('u1', { kind: 'tree', id: 't1' });
    await service.conclude('u1', { kind: 'conversation', id: 'c1' });
    expect(seen).toEqual([{ project: 'p1' }, undefined]);
  });

  it('starts the conclusion for its owner on the engine queue, waits for it and answers with what was saved', async () => {
    expect(await service.conclude('u1', { kind: 'tree', id: 't1' })).toEqual(saved);
    expect(workflows.start).toHaveBeenCalledWith(CONCLUDE_WORKSPACE_WORKFLOW, {
      workflowId: concludeWorkspaceId({ kind: 'tree', id: 't1' }),
      taskQueue: 'engine-queue',
      args: [{ ownerId: 'u1', workspace: { kind: 'tree', id: 't1' } }],
      ...startedFor('u1'),
    });
    expect(workflows.getHandle).toHaveBeenCalledWith(concludeWorkspaceId({ kind: 'tree', id: 't1' }));
  });

  it('joins a conclusion already under way for the same workspace rather than running a second one', async () => {
    workflows.start.mockRejectedValue(new WorkflowExecutionAlreadyStartedError('already started', 'wf', 'type'));
    expect(await service.conclude('u1', { kind: 'conversation', id: 'c1' })).toEqual(saved);
    expect(handle.result).toHaveBeenCalledTimes(1);
  });

  it('fails when the conclusion could not be started', async () => {
    workflows.start.mockRejectedValue(new Error('Temporal is not reachable'));
    await expect(service.conclude('u1', { kind: 'tree', id: 't1' })).rejects.toThrow('Temporal is not reachable');
    expect(workflows.getHandle).not.toHaveBeenCalled();
  });

  it('refuses with why, as a conflict, when the workspace could not be saved', async () => {
    handle.result.mockRejectedValue(new Error('Workflow failed', { cause: ApplicationFailure.nonRetryable('Pushing to koala-u1/research-c2 failed: Gitea is down') }));
    const refused = await service.conclude('u1', { kind: 'conversation', id: 'c2' }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(WorkspaceNotConcludedError);
    expect((refused as WorkspaceNotConcludedError).status).toBe(409);
    expect((refused as Error).message).toBe('the conversation\'s workspace could not be saved, so nothing was deleted: Pushing to koala-u1/research-c2 failed: Gitea is down');
  });

  it('says what went wrong even when the failure has no cause', async () => {
    handle.result.mockRejectedValue('gone');
    await expect(service.conclude('u1', { kind: 'tree', id: 't1' })).rejects.toThrow('the tree\'s workspace could not be saved, so nothing was deleted: gone');
  });
});
