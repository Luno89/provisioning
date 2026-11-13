import { AsyncLocalStorage } from 'node:async_hooks';
import type { Payload } from '@temporalio/common';
import { headerPayload, textOfHeader } from './telemetry.js';
import { WORK_HEADER } from './work-header.js';

export { WORK_HEADER } from './work-header.js';

export interface WorkFor {
  owner?: string | undefined;
  project?: string | undefined;
}

const UNNAMED = 'unnamed' as const;
const held = new AsyncLocalStorage<WorkFor | typeof UNNAMED>();

const named = (work: WorkFor): WorkFor => Object.fromEntries(Object.entries(work).filter(([, value]) => typeof value === 'string' && value)) as WorkFor;

export function workFor(): WorkFor | undefined {
  const current = held.getStore();
  return current && current !== UNNAMED ? current : undefined;
}

export const workIsUnnamed = (): boolean => held.getStore() === UNNAMED;

export const withWorkFor = <T>(work: WorkFor, run: () => T): T => held.run({ ...workFor(), ...named(work) }, run);

export const unnamedWork = <T>(run: () => T): T => held.run(UNNAMED, run);

export const workHeader = (work: WorkFor): Payload => headerPayload(JSON.stringify(named(work)));

export function workFromHeaders(headers: Record<string, Payload> | undefined): WorkFor | undefined {
  const text = textOfHeader(headers?.[WORK_HEADER]);
  if (!text) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const work = named(parsed as WorkFor);
  return Object.keys(work).length > 0 ? work : undefined;
}

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
