import type { WorkflowClient } from '@temporalio/client';
import { withWorkFor } from '@koala/engine-core/work-for';
import { startedFor } from '../../platform/index.js';
import type { WorkflowStarter } from '../registries/run-starter.js';

export function temporalWorkflowStarter(workflows: Pick<WorkflowClient, 'start' | 'getHandle'>): WorkflowStarter {
  return {
    async start(type, options) {
      const handle = await withWorkFor({ project: options.project }, () => workflows.start(type, {
        workflowId: options.workflowId,
        taskQueue: options.taskQueue,
        args: options.args,
        memo: options.memo,
        ...startedFor(options.owner),
      }));
      return { workflowId: handle.workflowId };
    },
    async signal(workflowId, name, payload) {
      await workflows.getHandle(workflowId).signal(name, ...(payload === undefined ? [] : [payload]));
    },
  };
}
