import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';
import { CancelledFailure } from '@temporalio/common';
import { ignore } from './failures.js';

interface Stopping {
  signal: AbortSignal;
  killed: string[];
}

const held = new AsyncLocalStorage<Stopping>();

export const stopsWith = <T>(signal: AbortSignal, run: () => T): T => held.run({ signal, killed: [] }, run);

export const stoppingWith = (): AbortSignal | undefined => held.getStore()?.signal;

export function killedWhenStopped(stop: (signal: NodeJS.Signals) => void, ended: Promise<unknown>, command: string): void {
  const stopping = held.getStore();
  if (!stopping) return;
  const { signal, killed } = stopping;
  const kill = (): void => {
    killed.push(basename(command));
    stop('SIGKILL');
  };
  if (signal.aborted) {
    kill();
    return;
  }
  signal.addEventListener('abort', kill, { once: true });
  void ended.then(() => signal.removeEventListener('abort', kill), () => signal.removeEventListener('abort', kill));
}

export interface KilledOnCancel {
  killed: string[];
}

interface Execute {
  execute<I>(input: I, next: (input: I) => Promise<unknown>): Promise<unknown>;
}

const reasonOf = (signal: AbortSignal): string => (signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'cancelled'));

interface RunningWork {
  workflowId: string;
  stop: AbortController;
  stopping: Stopping;
  ended: Promise<unknown>;
}

const runningWork = new Set<RunningWork>();

export async function stopWorkOf(workflowIds: readonly string[], why: string): Promise<string[]> {
  const named = new Set(workflowIds);
  const found = [...runningWork].filter((work) => named.has(work.workflowId));
  for (const work of found) work.stop.abort(why);
  await Promise.all(found.map((work) => work.ended));
  return [...new Set(found.flatMap((work) => work.stopping.killed))];
}

interface CancellableContext {
  cancellationSignal: AbortSignal;
  cancellationDetails?: { cancelRequested?: boolean } | undefined;
  info?: { workflowExecution?: { workflowId: string } | undefined } | undefined;
}

export function killOnCancel() {
  return (ctx: CancellableContext): { inbound: Execute } => ({
    inbound: {
      async execute(input, next) {
        const stop = new AbortController();
        const stopping: Stopping = { signal: AbortSignal.any([ctx.cancellationSignal, stop.signal]), killed: [] };
        const ran = held.run(stopping, () => next(input));
        const workflowId = ctx.info?.workflowExecution?.workflowId;
        const work = workflowId === undefined ? undefined : { workflowId, stop, stopping, ended: ran.then(() => undefined, ignore('a stop waits only for the work to have ended; how it ended reaches Temporal through the activity itself')) };
        if (work) runningWork.add(work);
        try {
          return await ran;
        } catch (err) {
          if (!ctx.cancellationDetails?.cancelRequested) throw err;
          const told: KilledOnCancel = { killed: stopping.killed };
          throw new CancelledFailure(reasonOf(ctx.cancellationSignal), [told], err instanceof Error ? err : undefined);
        } finally {
          if (work) runningWork.delete(work);
        }
      },
    },
  });
}
