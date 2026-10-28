import { describe, expect, it, vi } from 'vitest';
import { StoryDropService, type StoryDropDeps } from './StoryDropService.js';
import type { Leaf } from '../../projects/lib/leaves.js';
import type { DropArrival } from '../../engine-host/sandboxes/story-drop-work.js';

const leaf = { id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Portal', status: 'running' } as Leaf;
const files = [{ path: 'public/logo.svg', source: '/tmp/koala-drop-x/0', size: 6 }];

function setUp(arrival: DropArrival | Error) {
  const saved: Leaf[] = [];
  const forgot: string[] = [];
  const deps: StoryDropDeps = {
    leaves: { list: async () => [leaf], save: async (next) => { saved.push(next); } },
    treeOfLeaf: async () => ({ id: 't1', projectIds: ['p1'] }),
    account: async () => ({ username: 'koala-u1' }),
    credential: async () => ({ token: 'their-token', username: 'koala-u1' }),
    commit: vi.fn(async () => ({ commit: 'c1' })),
    work: {
      repoOf: async () => 'portal',
      arrive: vi.fn(async () => { if (arrival instanceof Error) throw arrival; return arrival; }),
      forget: async ({ branch }) => { forgot.push(branch); },
    },
    now: () => 'now',
    newId: () => 'd1',
  };
  return { drops: new StoryDropService(deps), deps, saved, forgot };
}

describe('code dropped on a story', () => {
  it('is committed as the person on a branch of its own from main, merged into the story\'s checkout, and that branch removed', async () => {
    const { drops, deps, saved, forgot } = setUp({ state: 'merged' });
    const outcome = await drops.drop('u1', 'p1', 'l1', files);
    expect(deps.commit).toHaveBeenCalledWith({ token: 'their-token', username: 'koala-u1' }, 'koala-u1', 'portal', files, 'Add public/logo.svg', 'main', 'drop/l1/d1');
    expect(deps.work.arrive).toHaveBeenCalledWith({ ownerId: 'u1', treeId: 't1', leafId: 'l1', branch: 'drop/l1/d1', message: 'Merge what was dropped on the story: Add public/logo.svg' });
    expect(outcome).toEqual({ ok: true, drop: { id: 'd1', branch: 'drop/l1/d1', paths: ['public/logo.svg'], at: 'now', by: 'u1', state: 'merged', mergedAt: 'now' }, said: 'public/logo.svg merged into the story\'s checkout' });
    expect(saved[0]?.drops).toEqual([outcome.ok && outcome.drop]);
    expect(forgot).toEqual(['drop/l1/d1']);
  });

  it('waits for the story\'s checkout when there is none yet, keeping its branch until then', async () => {
    const { drops, forgot } = setUp({ state: 'waiting', staged: true });
    expect(await drops.drop('u1', 'p1', 'l1', files)).toMatchObject({ ok: true, drop: { state: 'waiting' }, said: 'public/logo.svg will be merged into the story\'s checkout when it is next made' });
    expect(forgot).toEqual([]);
  });

  it('names the files that conflict and changes nothing in the checkout', async () => {
    const { drops } = setUp({ state: 'conflict', conflicts: ['public/logo.svg'] });
    expect(await drops.drop('u1', 'p1', 'l1', files)).toMatchObject({ ok: true, drop: { state: 'conflict', conflicts: ['public/logo.svg'] } });
  });

  it('refuses a story of another project or person, and removes its branch when the workspace fails', async () => {
    const { drops, forgot, saved } = setUp(new Error('the pod went away'));
    expect(await drops.drop('u1', 'p9', 'l1', files)).toEqual({ ok: false, status: 404, why: 'That story is not part of this project.' });
    expect(await drops.drop('u2', 'p1', 'l1', files)).toEqual({ ok: false, status: 404, why: 'There is no such story.' });
    await expect(drops.drop('u1', 'p1', 'l1', files)).rejects.toThrow('the pod went away');
    expect(forgot).toEqual(['drop/l1/d1']);
    expect(saved).toEqual([]);
  });
});
