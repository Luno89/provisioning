import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { failureOf, ignore } from '@koala/engine-core/failures';
import { reopening, type Reopening } from '@koala/engine-core/reopening';
import { MOVE_STEP_WORDS, type MovePart } from '../lib/instance-move.js';

export interface MovePartsDeps {
  root: { url: string; instanceId: string; credential: string };
  say(line: string): Promise<void> | void;
  fetch?: typeof fetch;
  wait?: Reopening;
}

export class MoveParts {
  constructor(private readonly deps: MovePartsDeps) {}

  part(name: MovePart | string, saying?: string): Promise<Readable>;
  part(name: MovePart | string, saying: string | undefined, absentFromOlder: true): Promise<Readable | undefined>;
  async part(name: MovePart | string, saying?: string, absentFromOlder?: true): Promise<Readable | undefined> {
    const words = saying ?? MOVE_STEP_WORDS[name as MovePart] ?? name;
    await this.deps.say(words);
    const call = this.deps.fetch ?? fetch;
    const again = this.deps.wait ?? reopening();
    const { url, instanceId, credential } = this.deps.root;
    let response: Response;
    for (;;) {
      const asked = await call(`${url}/api/instances/move/parts/${encodeURIComponent(name)}`, { headers: { 'x-instance-id': instanceId, authorization: `Bearer ${credential}` } }).then(
        (answer) => answer,
        (err: unknown) => {
          const failure = failureOf(err);
          if (failure.kind === 'final') throw err;
          return failure.reason;
        },
      );
      if (typeof asked !== 'string' && asked.status !== 502 && asked.status !== 503) {
        response = asked;
        break;
      }
      if (typeof asked !== 'string') await asked.body?.cancel();
      await this.deps.say(`  Koala's servers are not ready to give ${name} yet (${typeof asked === 'string' ? asked : `they answered ${asked.status}`}); asking again in ${again.seconds} s`);
      await again.after();
    }
    if (absentFromOlder && response.status === 404) {
      await response.body?.cancel();
      await this.deps.say(`  Koala's servers run a release that keeps no ${name}; there is none to copy`);
      return undefined;
    }
    if (!response.ok || !response.body) {
      const said = await response.text().catch((err: Error) => `its answer could not be read: ${err.message}`);
      let reason = said;
      try { reason = (JSON.parse(said) as { error?: string }).error ?? said; } catch (err) { ignore('an answer that is not JSON is its own reason')(err); }
      throw new Error(`Koala's servers would not give ${name} (${response.status}): ${reason}`);
    }
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  }
}

export async function textOf(stream: Readable): Promise<string> {
  let all = '';
  for await (const chunk of stream) all += chunk;
  return all;
}
