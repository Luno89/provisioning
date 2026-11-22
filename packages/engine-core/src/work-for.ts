import { AsyncLocalStorage } from 'node:async_hooks';
import { ApplicationFailure, type Payload } from '@temporalio/common';
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
  const carriesWhoseWorkItIs = (): { inbound: Execute } => ({
    inbound: {
      execute(input, next) {
        const work = workFromHeaders(input.headers);
        return work ? held.run(work, () => next(input)) : held.run(UNNAMED, () => next(input));
      },
    },
  });
  return carriesWhoseWorkItIs;
}

export interface Stopping {
  kind: 'owner' | 'project';
  id: string;
}

export class WorkStopped extends Error {
  readonly stopped: Stopping;

  constructor(stopped: Stopping) {
    super(stopped.kind === 'owner' ? 'this account is being removed' : 'this project is being deleted');
    this.name = 'WorkStopped';
    this.stopped = stopped;
  }
}

export interface DeletingMarks {
  owner: boolean;
  project: boolean;
}

export type ReadDeletingMarks = (work: WorkFor) => Promise<DeletingMarks>;

export type DeletingMarksHere = ReadDeletingMarks | { unread: string };

export function stoppedBy(work: WorkFor, marks: DeletingMarks): Stopping | undefined {
  if (work.owner && marks.owner && work.removing !== 'owner') return { kind: 'owner', id: work.owner };
  if (work.project && marks.project && !work.removing) return { kind: 'project', id: work.project };
  return undefined;
}

export async function refuseWhileDeleting(work: WorkFor | undefined, read: ReadDeletingMarks): Promise<void> {
  if (!work || (!work.owner && !work.project)) return;
  const stopped = stoppedBy(work, await read(work));
  if (stopped) throw new WorkStopped(stopped);
}

export function refusingDeletingWork(marks: DeletingMarksHere): (() => { inbound: Execute })[] {
  if (typeof marks !== 'function') return [];
  const refusesDeletingWork = (): { inbound: Execute } => ({
    inbound: {
      async execute(input, next) {
        try {
          await refuseWhileDeleting(workFromHeaders(input.headers), marks);
        } catch (err) {
          if (err instanceof WorkStopped) throw ApplicationFailure.nonRetryable(err.message, err.name);
          throw err;
        }
        return next(input);
      },
    },
  });
  return [refusesDeletingWork];
}
