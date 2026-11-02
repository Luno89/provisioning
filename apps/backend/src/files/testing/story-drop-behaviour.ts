import { describe, expect, it, vi } from 'vitest';
import { StoryDropService, type StoryDropDeps } from '../services/StoryDropService.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { Leaf } from '../../projects/lib/leaves.js';
import type { DropArrival } from '../../engine-host/sandboxes/story-drop-work.js';

const leaf = { id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Portal', status: 'running' } as Leaf;
const files = [{ path: 'public/logo.svg', source: '/tmp/koala-drop-x/0', size: 6 }];

async function setUp(db: Database, arrival: DropArrival | Error) {
  const forgot: string[] = [];
  await db.projects.saveTree({ id: 't1', ownerId: 'u1', name: 'Portal', type: 'service', projectIds: ['p1'], createdAt: 'x', updatedAt: 'x' } as never);
  await db.projects.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'Pages', createdAt: 'x', updatedAt: 'x' });
  await db.projects.saveLeaf(leaf);
  const deps: StoryDropDeps = {
    leaves: { list: () => db.projects.getLeaves(), save: (next) => db.projects.saveLeaf(next) },
    treeOfLeaf: async (of) => {
      const branch = (await db.projects.getBranches()).find((entry) => entry.id === of.branchId);
      return branch ? (await db.projects.getTrees()).find((tree) => tree.id === branch.treeId) : undefined;
    },
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
  const stored = async () => (await db.projects.getLeaves()).find((entry) => entry.id === 'l1')!;
  return { drops: new StoryDropService(deps), deps, stored, forgot };
}

export function storyDropBehaviour(make: () => Promise<Database>): void {
  describe('code dropped on a story', () => {
    it('is committed as the person on a branch of its own from main, merged into the story\'s checkout, and that branch removed', async () => {
      const { drops, deps, stored, forgot } = await setUp(await make(), { state: 'merged' });
      const outcome = await drops.drop('u1', 'p1', 'l1', files);
      expect(deps.commit).toHaveBeenCalledWith({ token: 'their-token', username: 'koala-u1' }, 'koala-u1', 'portal', files, 'Add public/logo.svg', 'main', 'drop/l1/d1');
      expect(deps.work.arrive).toHaveBeenCalledWith({ ownerId: 'u1', treeId: 't1', leafId: 'l1', branch: 'drop/l1/d1', message: 'Merge what was dropped on the story: Add public/logo.svg' });
      expect(outcome).toEqual({ ok: true, drop: { id: 'd1', branch: 'drop/l1/d1', paths: ['public/logo.svg'], at: 'now', by: 'u1', state: 'merged', mergedAt: 'now' }, said: 'public/logo.svg merged into the story\'s checkout' });
      expect((await stored()).drops).toEqual([outcome.ok && outcome.drop]);
      expect(forgot).toEqual(['drop/l1/d1']);
    });

    it('waits for the story\'s checkout when there is none yet, keeping its branch until then', async () => {
      const { drops, stored, forgot } = await setUp(await make(), { state: 'waiting', staged: true });
      expect(await drops.drop('u1', 'p1', 'l1', files)).toMatchObject({ ok: true, drop: { state: 'waiting' }, said: 'public/logo.svg will be merged into the story\'s checkout when it is next made' });
      expect((await stored()).drops).toMatchObject([{ id: 'd1', state: 'waiting' }]);
      expect(forgot).toEqual([]);
    });

    it('names the files that conflict and changes nothing in the checkout', async () => {
      const { drops, stored } = await setUp(await make(), { state: 'conflict', conflicts: ['public/logo.svg'] });
      expect(await drops.drop('u1', 'p1', 'l1', files)).toMatchObject({ ok: true, drop: { state: 'conflict', conflicts: ['public/logo.svg'] } });
      expect((await stored()).drops).toMatchObject([{ state: 'conflict', conflicts: ['public/logo.svg'] }]);
    });

    it('refuses a story of another project or person, and removes its branch when the workspace fails', async () => {
      const { drops, forgot, stored } = await setUp(await make(), new Error('the pod went away'));
      expect(await drops.drop('u1', 'p9', 'l1', files)).toEqual({ ok: false, status: 404, why: 'That story is not part of this project.' });
      expect(await drops.drop('u2', 'p1', 'l1', files)).toEqual({ ok: false, status: 404, why: 'There is no such story.' });
      await expect(drops.drop('u1', 'p1', 'l1', files)).rejects.toThrow('the pod went away');
      expect(forgot).toEqual(['drop/l1/d1']);
      expect((await stored()).drops).toBeUndefined();
    });
  });
}
