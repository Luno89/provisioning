import { RUN_ID_MEMO, workflowOfRun } from './contracts.js';
import type { Client } from '@temporalio/client';
import { ownerIn } from '../../platform/lib/workflow-owner.js';

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

export type RunLife = 'running' | 'ended' | 'not-theirs';

export const RUN_WATCH_RETRY_MS = 5_000;

export function runLifeVia(client: () => Promise<Client>): (runId: string, ownerId: string) => Promise<RunLife> {
  return async (runId, ownerId) => {
    try {
      const described = await (await client()).workflow.getHandle(workflowOfRun(runId)).describe();
      if (ownerIn(described.typedSearchAttributes) !== ownerId) return 'not-theirs';
      if (described.status.name !== 'RUNNING') return 'ended';
      const remembered = described.memo?.[RUN_ID_MEMO];
      return typeof remembered === 'string' && remembered !== runId ? 'ended' : 'running';
    } catch (err) {
      if ((err as { name?: string }).name === 'WorkflowNotFoundError') return 'ended';
      throw err;
    }
  };
}

export function runClosedVia(client: () => Promise<Client>, retryMs = RUN_WATCH_RETRY_MS): (runId: string, ownerId: string) => Promise<RunLife> {
  const life = runLifeVia(client);
  return async (runId, ownerId) => {
    for (;;) {
      await client().then((connected) => connected.workflow.getHandle(workflowOfRun(runId)).result()).catch(() => undefined);
      const now = await life(runId, ownerId).catch(() => 'running' as const);
      if (now !== 'running') return now;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  };
}
