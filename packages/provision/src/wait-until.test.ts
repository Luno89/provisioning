import { AssertionError } from 'node:assert';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { Hopeless, Waiting, waiting, waitUntil, type WaitOptions } from './wait-until.js';

const paused: number[] = [];
const instant = (): WaitOptions => {
  paused.length = 0;
  return { pause: async (ms) => { paused.push(ms); } };
};

describe('waitUntil', () => {
  it('returns the first answer that is not a state it waits through, keeping a zero and an empty string', async () => {
    let looks = 0;
    expect(await waitUntil('a zero', async () => { looks += 1; return looks < 3 ? waiting(`look ${looks}`) : 0; }, undefined, instant())).toBe(0);
    expect(looks).toBe(3);
    expect(await waitUntil('an empty answer', async () => '', undefined, instant())).toBe('');
  });

  it('stops at once when a look answers nothing, false or null, since a look says what it found or the state it waits through', async () => {
    for (const nothing of [undefined, false, null]) {
      await expect(waitUntil('root', async () => nothing as unknown as string, undefined, instant())).rejects.toThrow('root: a look answered nothing; answer what was found, or waiting(the state it is in)');
    }
  });

  it('says the state each look handed it while it waits', async () => {
    let looks = 0;
    const said: string[] = [];
    await waitUntil('every deployment to be failed', async () => {
      looks += 1;
      return looks < 30 ? waiting(`shop-3f2a1b: ${looks < 20 ? 'deploying' : 'stopping'}`) : true;
    }, undefined, { ...instant(), waiting: (what, last) => { said.push(`${what} (${last})`); } });
    expect(said[0]).toBe('every deployment to be failed (shop-3f2a1b: deploying)');
    expect(said.at(-1)).toBe('every deployment to be failed (shop-3f2a1b: stopping)');
  });

  it('says it is waiting as seldom as its caller asks', async () => {
    let looks = 0;
    const said: string[] = [];
    await waitUntil('root', async () => { looks += 1; return looks < 100 ? waiting('down') : true; }, undefined, { ...instant(), sayEvery: 40, waiting: (_what, last) => { said.push(last); } });
    expect(said).toEqual(['down', 'down']);
  });

  it('ends with the reason the moment what it waits on can never come', async () => {
    let looks = 0;
    await expect(waitUntil('the app', async () => { looks += 1; return waiting('deploying'); }, async () => 'the app failed: no image', instant())).rejects.toThrow('the app: the app failed: no image (deploying)');
    expect(looks).toBe(1);
    await expect(waitUntil('the job', async () => waiting('job/seed failed'), async () => 'job/seed failed: its log ends here', instant())).rejects.toThrow(/^the job: job\/seed failed: its log ends here$/);
  });

  it('asks again after a lost connection or an answer of not there yet, and never after a final one or a hopeless answer', async () => {
    let looks = 0;
    expect(await waitUntil('root', async () => {
      looks += 1;
      if (looks === 1) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (looks === 2) throw Object.assign(new Error('missing'), { response: { status: 404 } });
      if (looks === 3) throw Object.assign(new Error('busy'), { response: { status: 503 } });
      return 'up';
    }, undefined, instant())).toBe('up');
    let fetched = 0;
    expect(await waitUntil('Tempo through a port-forward not listening yet', async () => {
      fetched += 1;
      if (fetched === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:44419'), { code: 'ECONNREFUSED' }) });
      return 'up';
    }, undefined, instant())).toBe('up');
    await expect(waitUntil('root', async () => { throw new Hopeless('gone'); }, undefined, instant())).rejects.toThrow('gone');
    await expect(waitUntil('root', async () => { throw Object.assign(new Error('refused'), { response: { status: 401 } }); }, undefined, instant())).rejects.toThrow('refused');
  });

  it('stops at once on a mistake in what it looks at or a failed assertion, rather than looking forever', async () => {
    await expect(waitUntil('root', async () => { throw new TypeError('Cannot read properties of undefined'); }, undefined, instant())).rejects.toThrow(TypeError);
    await expect(waitUntil('root', async () => { throw new AssertionError({ message: 'wrong shape' }); }, undefined, instant())).rejects.toThrow('wrong shape');
  });

  it('keeps waiting while its end cannot be read for now, and stops when reading it fails for good', async () => {
    let looks = 0;
    expect(await waitUntil('root', async () => { looks += 1; return looks > 1 ? true : waiting('starting'); }, async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }, instant())).toBe(true);
    await expect(waitUntil('root', async () => waiting('starting'), async () => { throw new TypeError('no such field'); }, instant())).rejects.toThrow('no such field');
  });

  it('backs off from short pauses to longer ones and never stops on a count', async () => {
    let looks = 0;
    const options = instant();
    expect(await waitUntil('a slow thing', async () => { looks += 1; return looks > 30 ? 'there' : waiting('not there'); }, undefined, options)).toBe('there');
    expect(paused).toHaveLength(30);
    expect(paused[0]).toBeLessThan(paused.at(-1)!);
    expect([...paused].sort((a, b) => a - b)).toEqual(paused);
  });

  it('says it is still waiting, with the last thing that stood in the way, now and then', async () => {
    let looks = 0;
    const said: string[] = [];
    await waitUntil('root', async () => {
      looks += 1;
      if (looks < 30) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return true;
    }, undefined, { ...instant(), waiting: (what, last) => { said.push(`${what}: ${last}`); } });
    expect(said.length).toBeGreaterThan(0);
    expect(said.length).toBeLessThan(10);
    expect(said[0]).toBe('root: connect ECONNREFUSED');
  });

  it('cannot be handed a look that answers nothing, false or null where it should say the state it waits through: the type refuses it', () => {
    type Look = Parameters<typeof waitUntil<true>>[1];
    expectTypeOf<() => Promise<true | undefined>>().not.toExtend<Look>();
    expectTypeOf<() => Promise<boolean>>().not.toExtend<Look>();
    expectTypeOf<() => Promise<true | null>>().not.toExtend<Look>();
    expectTypeOf<() => Promise<true | Waiting>>().toExtend<Look>();
    expect(waiting('deploying')).toEqual(new Waiting('deploying'));
  });
});
