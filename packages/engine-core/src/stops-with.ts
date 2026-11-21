import { AsyncLocalStorage } from 'node:async_hooks';

const held = new AsyncLocalStorage<AbortSignal>();

export const stopsWith = <T>(signal: AbortSignal, run: () => T): T => held.run(signal, run);

export const stoppingWith = (): AbortSignal | undefined => held.getStore();

export function killedWhenStopped(stop: (signal: NodeJS.Signals) => void, ended: Promise<unknown>): void {
  const signal = stoppingWith();
  if (!signal) return;
  const kill = (): void => stop('SIGKILL');
  if (signal.aborted) {
    kill();
    return;
  }
  signal.addEventListener('abort', kill, { once: true });
  void ended.then(() => signal.removeEventListener('abort', kill), () => signal.removeEventListener('abort', kill));
}

interface Execute {
  execute<I>(input: I, next: (input: I) => Promise<unknown>): Promise<unknown>;
}

export function killOnCancel() {
  return (ctx: { cancellationSignal: AbortSignal }): { inbound: Execute } => ({
    inbound: {
      execute: (input, next) => stopsWith(ctx.cancellationSignal, () => next(input)),
    },
  });
}
