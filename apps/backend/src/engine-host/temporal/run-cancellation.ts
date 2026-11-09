import { ignore } from '@koala/engine-core/failures';
import { RUN_ID_MEMO, workflowOfRun } from './contracts.js';
import type { Client } from '@temporalio/client';
import { ownerIn } from '../../platform/lib/workflow-owner.js';
import { thrownFor, type DependencyReporter } from '../../platform/lib/dependencies.js';
import { reopening, type Reopening } from '@koala/engine-core/reopening';

export const RUN_STATE_QUERY = 'runState';

export interface RunState {
  nodeId?: string | undefined;
  rounds: number;
  cancelled: boolean;
  asking?: string[] | undefined;
  waitsFor?: string[] | undefined;
}

const gone = (err: unknown): boolean => (err as { name?: string } | undefined)?.name === 'WorkflowNotFoundError';

const askedOf = (client: () => Promise<Client>, reporter: DependencyReporter | undefined) => async <T>(ask: (connected: Client) => Promise<T>, whenGone: T): Promise<T> => {
  let answer: T;
  try {
    answer = await ask(await client());
  } catch (err) {
    if (gone(err)) return whenGone;
    throw thrownFor(reporter, 'temporal', err);
  }
  reporter?.answered('temporal');
  return answer;
};

const stateOf = (connected: Client, runId: string) => connected.workflow.getHandle(workflowOfRun(runId)).query<RunState>(RUN_STATE_QUERY);

export function runCancelledVia(client: () => Promise<Client>, reporter?: DependencyReporter): (runId: string) => Promise<boolean> {
  const asked = askedOf(client, reporter);
  return (runId) => asked(async (connected) => (await stateOf(connected, runId)).cancelled === true, false);
}

export function runAskingVia(client: () => Promise<Client>, reporter?: DependencyReporter): (runId: string) => Promise<string[]> {
  const asked = askedOf(client, reporter);
  return (runId) => asked(async (connected) => (await stateOf(connected, runId)).asking ?? [], []);
}

export function runWaitingVia(client: () => Promise<Client>, reporter?: DependencyReporter): (runId: string) => Promise<{ asking: string[]; waitsFor: string[] }> {
  const asked = askedOf(client, reporter);
  return (runId) => asked(async (connected) => {
    const state = await stateOf(connected, runId);
    return { asking: state.asking ?? [], waitsFor: state.waitsFor ?? [] };
  }, { asking: [], waitsFor: [] });
}

export function runEndedVia(client: () => Promise<Client>, reporter?: DependencyReporter): (runId: string) => Promise<boolean> {
  const asked = askedOf(client, reporter);
  return (runId) => asked(async (connected) => {
    const described = await connected.workflow.getHandle(workflowOfRun(runId)).describe();
    if (described.status.name !== 'RUNNING') return true;
    const remembered = described.memo?.[RUN_ID_MEMO];
    return typeof remembered === 'string' && remembered !== runId;
  }, true);
}

export type RunLife = 'running' | 'ended' | 'not-theirs';

export const RUN_WATCH_RETRY_MS = 5_000;

export function runLifeVia(client: () => Promise<Client>, reporter?: DependencyReporter): (runId: string, ownerId: string) => Promise<RunLife> {
  const asked = askedOf(client, reporter);
  return (runId, ownerId) => asked(async (connected): Promise<RunLife> => {
    const described = await connected.workflow.getHandle(workflowOfRun(runId)).describe();
    if (ownerIn(described.typedSearchAttributes) !== ownerId) return 'not-theirs';
    if (described.status.name !== 'RUNNING') return 'ended';
    const remembered = described.memo?.[RUN_ID_MEMO];
    return typeof remembered === 'string' && remembered !== runId ? 'ended' : 'running';
  }, 'ended');
}

export function runClosedVia(client: () => Promise<Client>, reporter?: DependencyReporter, again: () => Reopening = () => reopening(RUN_WATCH_RETRY_MS)): (runId: string, ownerId: string) => Promise<RunLife> {
  const life = runLifeVia(client, reporter);
  return async (runId, ownerId) => {
    const wait = again();
    for (;;) {
      await client().then((connected) => connected.workflow.getHandle(workflowOfRun(runId)).result()).catch(ignore('a run that failed or was terminated rejects here as well, and whether it closed is asked next'));
      const now = await life(runId, ownerId).then((read) => { wait.reset(); return read; }, () => 'unread' as const);
      if (now === 'ended' || now === 'not-theirs') return now;
      await wait.after();
    }
  };
}
