import { AssertionError } from 'node:assert';
import { statusFailure } from '@koala/engine-core/failures';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Hopeless extends Error {}

const NOT_THERE_YET = new Set([404, 409, 425]);
const MISTAKES = [TypeError, ReferenceError, RangeError, SyntaxError];

function waitingOn(err: unknown): string {
  if (err instanceof Hopeless || err instanceof AssertionError || MISTAKES.some((kind) => err instanceof kind)) throw err;
  const status = (err as { response?: { status?: number } }).response?.status;
  if (status !== undefined && !NOT_THERE_YET.has(status) && statusFailure(status).kind === 'final') throw err;
  return err instanceof Error ? err.message : String(err);
}

export async function until<T>(what: string, look: () => Promise<T | undefined | false | null>, ended?: () => Promise<string | undefined | false | void>): Promise<T> {
  let last = '';
  for (let tries = 1; ; tries += 1) {
    try {
      const found = await look();
      if (found !== undefined && found !== false && found !== null) return found;
      last = '';
    } catch (err) {
      last = waitingOn(err);
    }
    let reason: string | undefined | false | void;
    try {
      reason = ended ? await ended() : undefined;
    } catch (err) {
      last = `its end could not be read: ${waitingOn(err)}`;
    }
    if (reason) throw new Error(`${what}: ${reason}${last ? ` (${last.slice(0, 200)})` : ''}`);
    if (tries % 12 === 0) console.log(`    still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
    await sleep(tries < 5 ? 500 : 2000);
  }
}
