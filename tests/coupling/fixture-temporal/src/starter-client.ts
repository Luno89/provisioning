import type { WorkflowClient } from '@temporalio/client';
import type { Starter } from './starter.js';

export function starterOn(client: WorkflowClient): Starter {
  return {
    start: async (type, workflowId) => {
      await client.start(type, { taskQueue: 'q', workflowId });
    },
  };
}
