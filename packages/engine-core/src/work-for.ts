import { AsyncLocalStorage } from 'node:async_hooks';
import type { Payload } from '@temporalio/common';
import { WORK_HEADER, namedOnly, workOfPayload, workPayload, type WorkNamed } from './work-header.js';

export { WORK_HEADER } from './work-header.js';

export type WorkFor = WorkNamed;

const UNNAMED = 'unnamed' as const;
const held = new AsyncLocalStorage<WorkFor | typeof UNNAMED>();

const named = namedOnly;

export function workFor(): WorkFor | undefined {
  const current = held.getStore();
  return current && current !== UNNAMED ? current : undefined;
}

export const workIsUnnamed = (): boolean => held.getStore() === UNNAMED;

export function withWorkFor<T>(work: WorkFor, run: () => T): T {
  if (workIsUnnamed()) return run();
  const merged = { ...workFor(), ...named(work) };
  return Object.keys(merged).length > 0 ? held.run(merged, run) : run();
}

export const unnamedWork = <T>(run: () => T): T => held.run(UNNAMED, run);

export const workHeader = (work: WorkFor): Payload => workPayload(work);

export const workFromHeaders = (headers: Record<string, Payload> | undefined): WorkFor | undefined => workOfPayload(headers?.[WORK_HEADER]);

interface Execute {
  execute<I extends { headers: Record<string, Payload> }, R>(input: I, next: (input: I) => Promise<R>): Promise<R>;
}

export function carryWorkFor() {
  return (): { inbound: Execute } => ({
    inbound: {
      execute(input, next) {
        const work = workFromHeaders(input.headers);
        return work ? held.run(work, () => next(input)) : held.run(UNNAMED, () => next(input));
      },
    },
  });
}

export class WorkStopped extends Error {
  readonly stopped: { kind: 'owner' | 'project'; id: string };

  constructor(stopped: { kind: 'owner' | 'project'; id: string }) {
    super(stopped.kind === 'owner' ? `the account ${stopped.id} is being removed, so nothing more is kept for it` : `the project ${stopped.id} is being deleted, so nothing more is kept for it`);
    this.name = 'WorkStopped';
    this.stopped = stopped;
  }
}
