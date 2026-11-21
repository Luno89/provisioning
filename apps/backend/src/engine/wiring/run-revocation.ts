import { WorkflowNotFoundError, type WorkflowClient } from '@temporalio/client';
import type { RevokedBecause } from '../../platform/index.js';
import { workflowOfRun } from '../../engine-host/temporal/contracts.js';

export const revokeRunSignal = (workflows: () => WorkflowClient) => async (runId: string, revocation: { because: RevokedBecause; at: string }): Promise<void> => {
  try {
    await workflows().getHandle(workflowOfRun(runId)).signal('revokeRun', revocation);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return;
    throw err;
  }
};
