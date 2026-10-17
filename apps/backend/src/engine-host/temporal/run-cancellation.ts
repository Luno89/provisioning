import { RUN_ID_MEMO, workflowOfRun } from './contracts.js';
import type { Client } from '@temporalio/client';

export const RUN_STATE_QUERY = 'runState';

export interface RunState {
  nodeId?: string | undefined;
  rounds: number;
  cancelled: boolean;
  asking?: string[] | undefined;
  waitsFor?: string[] | undefined;
}

export function runCancelledVia(client: () => Promise<Client>): (runId: string) => Promise<boolean> {
  return async (runId) => {
    try {
      const state = await (await client()).workflow.getHandle(workflowOfRun(runId)).query<RunState>(RUN_STATE_QUERY);
      return state.cancelled === true;
    } catch {
      return false;
    }
  };
}

export function runAskingVia(client: () => Promise<Client>): (runId: string) => Promise<string[]> {
  return async (runId) => {
    try {
      const state = await (await client()).workflow.getHandle(workflowOfRun(runId)).query<RunState>(RUN_STATE_QUERY);
      return state.asking ?? [];
    } catch {
      return [];
    }
  };
}

export function runWaitingVia(client: () => Promise<Client>): (runId: string) => Promise<{ asking: string[]; waitsFor: string[] }> {
  return async (runId) => {
    try {
      const state = await (await client()).workflow.getHandle(workflowOfRun(runId)).query<RunState>(RUN_STATE_QUERY);
      return { asking: state.asking ?? [], waitsFor: state.waitsFor ?? [] };
    } catch {
      return { asking: [], waitsFor: [] };
    }
  };
}

export function runEndedVia(client: () => Promise<Client>): (runId: string) => Promise<boolean> {
  return async (runId) => {
    try {
      const described = await (await client()).workflow.getHandle(workflowOfRun(runId)).describe();
      if (described.status.name !== 'RUNNING') return true;
      const remembered = described.memo?.[RUN_ID_MEMO];
      return typeof remembered === 'string' && remembered !== runId;
    } catch (err) {
      return (err as { name?: string }).name === 'WorkflowNotFoundError';
    }
  };
}
