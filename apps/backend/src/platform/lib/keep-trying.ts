import { WorkflowExecutionAlreadyStartedError, type SearchAttributePair } from '@temporalio/common';
import { failureOf } from '@koala/engine-core/failures';
import { PLATFORM_OWNER, startedFor } from './workflow-owner.js';
import { reopening, type Reopening } from '@koala/engine-core/reopening';

export type StopsNaming = (what: string, reason: string) => void;

export interface PlatformWorkflowStart {
  start: (options: { workflowId: string; taskQueue: string; args: []; typedSearchAttributes: SearchAttributePair[] }) => Promise<unknown>;
  workflowId: string;
  taskQueue: string;
  waiting: string;
  refused: string;
  stopsNaming: StopsNaming;
  log?: ((message: string) => void) | undefined;
}

export function keepPlatformWorkflowRunning(run: PlatformWorkflowStart): void {
  void keepTrying(run.waiting, async () => {
    try {
      await run.start({ workflowId: run.workflowId, taskQueue: run.taskQueue, args: [], ...startedFor(PLATFORM_OWNER) });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) return;
      throw error;
    }
  }, run.log ?? ((message) => console.warn(message)), (reason) => run.stopsNaming(run.refused, reason));
}

export function stopsNamingWith(stop: (code: number) => void, say: (line: string) => void): StopsNaming {
  return (what, reason) => {
    say(`[bootstrap] ${what} was refused for good, so this process stops: ${reason}`);
    stop(1);
  };
}

export function keepTrying(what: string, attempt: () => Promise<void>, log: (message: string) => void, final: (reason: string) => void, again: Reopening = reopening()): Promise<boolean> {
  const once = async (): Promise<boolean> => {
    try {
      await attempt();
      return true;
    } catch (err) {
      const failure = failureOf(err);
      if (failure.kind === 'final') {
        final(failure.reason);
        return false;
      }
      log(`${what}: ${failure.reason}; trying again in ${again.seconds} s`);
      again.later(() => { void once(); });
      return false;
    }
  };
  return once();
}
