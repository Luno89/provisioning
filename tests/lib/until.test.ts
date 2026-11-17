import { describe, expect, it } from 'vitest';
import { Hopeless, until } from './until.js';

describe('until', () => {
  it('returns the first answer that is not nothing, keeping a zero', async () => {
    let looks = 0;
    expect(await until('a zero', async () => { looks += 1; return looks < 2 ? undefined : 0; })).toBe(0);
    expect(looks).toBe(2);
  });

  it('ends with the reason the moment what it waits on can never come', async () => {
    let looks = 0;
    await expect(until('the app', async () => { looks += 1; return undefined; }, async () => 'the app failed: no image')).rejects.toThrow('the app: the app failed: no image');
    expect(looks).toBe(1);
  });

  it('asks again after a lost connection or an answer of not there yet, and never after a final one or a hopeless answer', async () => {
    let looks = 0;
    expect(await until('root', async () => { looks += 1; if (looks === 1) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); if (looks === 2) throw Object.assign(new Error('missing'), { response: { status: 404 } }); return 'up'; })).toBe('up');
    await expect(until('root', async () => { throw new Hopeless('gone'); })).rejects.toThrow('gone');
    await expect(until('root', async () => { throw Object.assign(new Error('refused'), { response: { status: 401 } }); })).rejects.toThrow('refused');
  });

  it('stops at once on a mistake in what it looks at, rather than looking forever', async () => {
    await expect(until('root', async () => { throw new TypeError('Cannot read properties of undefined'); })).rejects.toThrow(TypeError);
  });

  it('keeps waiting while its end cannot be read for now, and stops when reading it fails for good', async () => {
    let looks = 0;
    expect(await until('root', async () => { looks += 1; return looks > 1 ? true : undefined; }, async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); })).toBe(true);
    await expect(until('root', async () => undefined, async () => { throw new TypeError('no such field'); })).rejects.toThrow('no such field');
  });
});
