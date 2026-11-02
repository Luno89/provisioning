import type { WorkflowClient, WorkflowHandle } from '@temporalio/client';

export type WorkflowRun = Pick<WorkflowHandle, 'workflowId' | 'signal' | 'query' | 'describe' | 'result' | 'cancel' | 'terminate' | 'fetchHistory'>;

export interface Workflows {
  start: WorkflowClient['start'];
  signalWithStart: WorkflowClient['signalWithStart'];
  getHandle(workflowId: string, runId?: string): WorkflowRun;
  list: WorkflowClient['list'];
  count: WorkflowClient['count'];
}
