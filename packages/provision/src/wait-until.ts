import { AssertionError } from 'node:assert';
import { statusFailure } from '@koala/engine-core/failures';
import { Hopeless } from '@koala/engine-core/until';

export { Hopeless };

export class Waiting {
  private declare readonly brand: 'waiting';
  constructor(readonly state: string) {}
}

export const waiting = (state: string): Waiting => new Waiting(state);

export type Found = string | number | bigint | symbol | true | object;

export interface WaitOptions {
  pause?: (ms: number) => Promise<void>;
  waiting?: (what: string, last: string) => void;
  sayEvery?: number;
}

export const FIRST_PAUSE_MS = 500;
export const LATER_PAUSE_MS = 2000;
const SHORT_PAUSES = 4;
const SAY_EVERY = 12;
const NOT_THERE_YET = new Set([404, 409, 425]);
const MISTAKES = [TypeError, ReferenceError, RangeError, SyntaxError];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function waitingOn(err: unknown): string {
  if (err instanceof Hopeless || err instanceof AssertionError || MISTAKES.some((kind) => err instanceof kind)) throw err;
  const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
  if (status !== undefined && !NOT_THERE_YET.has(status) && statusFailure(status).kind === 'final') throw err;
  return err instanceof Error ? err.message : String(err);
}

const NOTHING = 'a look answered nothing; answer what was found, or waiting(the state it is in)';

export async function waitUntil<T extends Found>(what: string, look: () => Promise<T | Waiting>, hopeless?: () => Promise<string | undefined | false | void>, options: WaitOptions = {}): Promise<T> {
  const pause = options.pause ?? sleep;
  const sayEvery = options.sayEvery ?? SAY_EVERY;
  let last = '';
  for (let looked = 1; ; looked += 1) {
    let found: T | Waiting;
    try {
      found = await look();
    } catch (err) {
      found = waiting(waitingOn(err));
    }
    if (found === undefined || found === null || (found as unknown) === false) throw new TypeError(`${what}: ${NOTHING}`);
    if (!(found instanceof Waiting)) return found;
    last = found.state;
    let reason: string | undefined | false | void;
    try {
      reason = hopeless ? await hopeless() : undefined;
    } catch (err) {
      last = `its end could not be read: ${waitingOn(err)}`;
    }
    if (reason) throw new Error(`${what}: ${reason}${last && !reason.includes(last) ? ` (${last.slice(0, 200)})` : ''}`);
    if (looked % sayEvery === 0) options.waiting?.(what, last.slice(0, 200));
    await pause(looked <= SHORT_PAUSES ? FIRST_PAUSE_MS : LATER_PAUSE_MS);
  }
}
