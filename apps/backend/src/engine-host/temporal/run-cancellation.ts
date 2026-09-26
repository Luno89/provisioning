import type { Client } from '@temporalio/client';

export const RUN_STATE_QUERY = 'runState';

export interface RunState {
  nodeId?: string | undefined;
  rounds: number;
  cancelled: boolean;
}

export function runCancelledVia(client: () => Promise<Client>): (runId: string) => Promise<boolean> {
  return async (runId) => {
    try {
      const state = await (await client()).workflow.getHandle(runId).query<RunState>(RUN_STATE_QUERY);
      return state.cancelled === true;
    } catch {
      return false;
    }
  };
}
