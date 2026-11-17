import { AssertionError } from 'node:assert';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Hopeless extends Error {}

const NOT_FINAL = new Set([404, 408, 409, 425, 429]);

function final(err: unknown): boolean {
  if (err instanceof Hopeless || err instanceof AssertionError) return true;
  const status = (err as { response?: { status?: number } }).response?.status;
  return status !== undefined && status >= 400 && status < 500 && !NOT_FINAL.has(status);
}

export async function until<T>(what: string, look: () => Promise<T | undefined | false | null>, ended?: () => Promise<string | undefined | false | void>): Promise<T> {
  let last = '';
  for (let tries = 1; ; tries += 1) {
    try {
      const found = await look();
      if (found !== undefined && found !== false && found !== null) return found;
      last = '';
    } catch (err) {
      if (final(err)) throw err;
      last = (err as Error).message;
    }
    const reason = ended ? await ended().catch(() => undefined) : undefined;
    if (reason) throw new Error(`${what}: ${reason}${last ? ` (${last.slice(0, 200)})` : ''}`);
    if (tries % 12 === 0) console.log(`    still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
    await sleep(tries < 5 ? 500 : 2000);
  }
}
