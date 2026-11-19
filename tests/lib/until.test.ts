import { describe, expect, it, vi } from 'vitest';
import { Hopeless, until, waiting } from './until.js';

describe('until', () => {
  it('returns the first answer that is not nothing, keeping a zero', async () => {
    let looks = 0;
    expect(await until('a zero', async () => { looks += 1; return looks < 2 ? waiting('not yet') : 0; })).toBe(0);
    expect(looks).toBe(2);
  });

  it('ends with the reason the moment what it waits on can never come', async () => {
    let looks = 0;
    await expect(until('the app', async () => { looks += 1; return waiting('deploying'); }, async () => 'the app failed: no image')).rejects.toThrow('the app: the app failed: no image (deploying)');
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
    expect(await until('root', async () => { looks += 1; return looks > 1 ? true : waiting('starting'); }, async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); })).toBe(true);
    await expect(until('root', async () => waiting('starting'), async () => { throw new TypeError('no such field'); })).rejects.toThrow('no such field');
  });

  it('prints the state it is watching while it waits, so a stuck test says what it is stuck on', async () => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.useFakeTimers();
    let looks = 0;
    try {
      const done = until('every deployment to be failed', async () => { looks += 1; return looks < 13 ? waiting('shop-3f2a1b: deploying') : true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await done).toBe(true);
      expect(printed).toHaveBeenCalledWith('    still waiting for every deployment to be failed (shop-3f2a1b: deploying)');
    } finally {
      vi.useRealTimers();
      printed.mockRestore();
    }
  });
});
