import { describe, expect, it } from 'vitest';
import { WorkStopped, unnamedWork, withWorkFor } from '@koala/engine-core/work-for';
import { Fence } from './fence.js';

describe('the fence a removal puts round an account or a project', () => {
  it('refuses work for an account being removed, and lets every other account\'s work through', async () => {
    const fence = new Fence();
    fence.close({ kind: 'owner', id: 'leaving' });
    await expect(withWorkFor({ owner: 'leaving' }, () => fence.guard(async () => 'kept'))).rejects.toEqual(new WorkStopped({ kind: 'owner', id: 'leaving' }));
    await expect(withWorkFor({ owner: 'staying' }, () => fence.guard(async () => 'kept'))).resolves.toBe('kept');
  });

  it('refuses work for a project being deleted, whoever owns it', async () => {
    const fence = new Fence();
    fence.close({ kind: 'project', id: 'p1' });
    await expect(withWorkFor({ owner: 'u1', project: 'p1' }, () => fence.guard(async () => 'kept'))).rejects.toBeInstanceOf(WorkStopped);
    await expect(withWorkFor({ owner: 'u1', project: 'p2' }, () => fence.guard(async () => 'kept'))).resolves.toBe('kept');
  });

  it('never refuses work that names no account, which is what a removal\'s own steps and a request outside any run do', async () => {
    const fence = new Fence();
    fence.close({ kind: 'owner', id: 'leaving' });
    await expect(fence.guard(async () => 'kept')).resolves.toBe('kept');
    await expect(unnamedWork(() => fence.guard(async () => 'kept'))).resolves.toBe('kept');
  });

  it('is quiet for an account only once every piece of its work that got past the fence before it closed has finished', async () => {
    const fence = new Fence();
    let finish!: () => void;
    const inFlight = withWorkFor({ owner: 'leaving' }, () => fence.guard(() => new Promise<void>((resolve) => { finish = resolve; })));
    fence.close({ kind: 'owner', id: 'leaving' });
    let quiet = false;
    const waiting = fence.quiet({ kind: 'owner', id: 'leaving' }).then(() => { quiet = true; });
    await Promise.resolve();
    expect(quiet).toBe(false);
    finish();
    await inFlight;
    await waiting;
    expect(quiet).toBe(true);
    await expect(fence.quiet({ kind: 'owner', id: 'nobody' })).resolves.toBeUndefined();
  });
});
