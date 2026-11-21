import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';
import { CancelledFailure } from '@temporalio/common';

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

export function killOnCancel() {
  return (ctx: { cancellationSignal: AbortSignal; cancellationDetails?: { cancelRequested?: boolean } | undefined }): { inbound: Execute } => ({
    inbound: {
      async execute(input, next) {
        const stopping: Stopping = { signal: ctx.cancellationSignal, killed: [] };
        try {
          return await held.run(stopping, () => next(input));
        } catch (err) {
          if (!ctx.cancellationDetails?.cancelRequested) throw err;
          const told: KilledOnCancel = { killed: stopping.killed };
          throw new CancelledFailure(reasonOf(ctx.cancellationSignal), [told], err instanceof Error ? err : undefined);
        }
      },
    },
  });
}
