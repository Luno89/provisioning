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

  it('asks again after a lost connection, and never after an assertion or a hopeless answer', async () => {
    let looks = 0;
    expect(await until('root', async () => { looks += 1; if (looks === 1) throw new Error('connect ECONNREFUSED'); return 'up'; })).toBe('up');
    await expect(until('root', async () => { throw new Hopeless('gone'); })).rejects.toThrow('gone');
    await expect(until('root', async () => { throw Object.assign(new Error('refused'), { response: { status: 401 } }); })).rejects.toThrow('refused');
  });

  it('treats a reason that cannot be read as nothing to report', async () => {
    let looks = 0;
    expect(await until('root', async () => { looks += 1; return looks > 1 ? true : undefined; }, async () => { throw new Error('docker did not answer'); })).toBe(true);
  });
});
