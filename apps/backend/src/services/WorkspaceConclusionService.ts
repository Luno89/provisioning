import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { CONCLUDE_WORKSPACE_WORKFLOW, concludeWorkspaceId, type ConcludeWorkspaceArgs, type ConcludedWorkspace } from '../engine-host/temporal/contracts.js';
import type { SavedDocuments } from '../engine-host/sandboxes/workspace-documents.js';

export interface ConclusionWorkflows {
  start(workflowType: string, options: { workflowId: string; taskQueue: string; args: [ConcludeWorkspaceArgs] }): Promise<unknown>;
  getHandle(workflowId: string): { result(): Promise<unknown> };
}

export class WorkspaceNotConcludedError extends Error {
  readonly status = 409;
}

const causeOf = (err: unknown): string => {
  let current: unknown = err;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  return current instanceof Error ? current.message : String(current);
};

/** Concludes a saved workspace through ConcludeWorkspaceWorkflow and waits for it, joining one already under way for the same workspace. */
export class WorkspaceConclusionService {
  constructor(private readonly deps: { workflows: () => Promise<ConclusionWorkflows>; taskQueue: string }) {}

  async conclude(ownerId: string, workspace: ConcludedWorkspace): Promise<SavedDocuments> {
    const workflows = await this.deps.workflows();
    const workflowId = concludeWorkspaceId(workspace);
    try {
      await workflows.start(CONCLUDE_WORKSPACE_WORKFLOW, { workflowId, taskQueue: this.deps.taskQueue, args: [{ ownerId, workspace }] });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    }
    try {
      return await workflows.getHandle(workflowId).result() as SavedDocuments;
    } catch (err) {
      throw new WorkspaceNotConcludedError(`the ${workspace.kind}'s workspace could not be saved, so nothing was deleted: ${causeOf(err)}`);
    }
  }
}
