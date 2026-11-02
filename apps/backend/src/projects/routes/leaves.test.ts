import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { CALLER, del, get, post } from '../testing/route-call.js';
import type { Leaf } from '../lib/leaves.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { GroveRunService } from '../services/GroveRunService.js';
import { leavesRouter } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: CALLER.id, branchId: 'b1', title: 'do a thing', status: 'pending', createdAt: 't', updatedAt: 't', ...over,
});

function setUp() {
  const db = memoryDatabase();
  const runs = mock<GroveRunService>();
  const deletion = mock<GroveDeletionService>();
  const router = leavesRouter({ db: db.projects, runs, deletion });
  return { db, runs, deletion, router };
}

describe('listing leaves', () => {
  it('shows only the caller\'s leaves, optionally one branch\'s', async () => {
    const { db, router } = setUp();
    await db.projects.saveLeaf(leaf({ id: 'mine' }));
    await db.projects.saveLeaf(leaf({ id: 'other-branch', branchId: 'b2' }));
    await db.projects.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else' }));
    expect(((await get(router, '/')).body as Leaf[]).map((entry) => entry.id)).toEqual(['mine', 'other-branch']);
    expect(((await get(router, '/?branchId=b2')).body as Leaf[]).map((entry) => entry.id)).toEqual(['other-branch']);
  });

  it('answers with the error rather than hanging when the database throws', async () => {
    const router = leavesRouter({ db: { getLeaves: async () => { throw new Error('db is down'); } }, runs: mock<GroveRunService>(), deletion: mock<GroveDeletionService>() });
    expect(await get(router, '/')).toEqual({ status: 500, body: { error: 'db is down' } });
  });
});

describe('acting on one leaf', () => {
  it('answers 404 for another owner\'s leaf on every route that takes an id, calling no service', async () => {
    const { db, runs, router } = setUp();
    await db.projects.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else', status: 'failed' }));
    const answers = [
      await post(router, '/theirs/retry', {}),
      await post(router, '/theirs/settle', { verdict: 'verified' }),
      await post(router, '/theirs/cancel', {}),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404]);
    expect(runs.retryLeaf).not.toHaveBeenCalled();
    expect(runs.settleClaim).not.toHaveBeenCalled();
    expect(runs.cancelLeaf).not.toHaveBeenCalled();
  });

  it('retries the caller\'s leaf and answers what the run service answers, a refusal with its status', async () => {
    const { db, runs, router } = setUp();
    const failed = leaf({ status: 'failed' });
    await db.projects.saveLeaf(failed);
    runs.retryLeaf.calledWith(CALLER.id, matches<Leaf>((given) => given.id === 'l1')).mockResolvedValueOnce({ ok: true, value: { ...failed, status: 'pending' } });
    expect(await post(router, '/l1/retry', {})).toMatchObject({ status: 200, body: { id: 'l1', status: 'pending' } });
    runs.retryLeaf.mockResolvedValueOnce({ ok: false, status: 409, error: 'Only a failed leaf can be retried' });
    expect(await post(router, '/l1/retry', {})).toEqual({ status: 409, body: { error: 'Only a failed leaf can be retried' } });
  });

  it('settles with a verdict and a trimmed note, and refuses any other verdict before asking the service', async () => {
    const { db, runs, router } = setUp();
    await db.projects.saveLeaf(leaf());
    runs.settleClaim.mockResolvedValue({ ok: true, value: leaf({ status: 'succeeded' }) });
    expect(await post(router, '/l1/settle', { verdict: 'verified', note: '  looks right ' })).toMatchObject({ status: 200, body: { status: 'succeeded' } });
    expect(runs.settleClaim).toHaveBeenCalledWith(matches<Leaf>((given) => given.id === 'l1'), 'verified', 'looks right');
    expect(await post(router, '/l1/settle', { verdict: 'maybe' })).toEqual({ status: 400, body: { error: "verdict is 'verified' or 'failed'" } });
    expect(runs.settleClaim).toHaveBeenCalledTimes(1);
    runs.settleClaim.mockResolvedValueOnce({ ok: false, status: 409, error: 'Nothing is claimed' });
    expect(await post(router, '/l1/settle', { verdict: 'failed' })).toEqual({ status: 409, body: { error: 'Nothing is claimed' } });
  });

  it('cancels the caller\'s leaf and passes on a refusal', async () => {
    const { db, runs, router } = setUp();
    await db.projects.saveLeaf(leaf());
    runs.cancelLeaf.mockResolvedValueOnce({ ok: true, value: leaf({ status: 'cancelled' }) });
    expect(await post(router, '/l1/cancel', {})).toMatchObject({ status: 200, body: { status: 'cancelled' } });
    runs.cancelLeaf.mockResolvedValueOnce({ ok: false, status: 409, error: 'Only unfinished work can be cancelled' });
    expect(await post(router, '/l1/cancel', {})).toEqual({ status: 409, body: { error: 'Only unfinished work can be cancelled' } });
  });

  it('deletes through the deletion service as the caller and reports what went', async () => {
    const { deletion, router } = setUp();
    const scope = { treeId: undefined, branchIds: [], leafIds: ['l1'], taskIds: [], proposalIds: [], conversationIds: [], adoptingProposalIds: [] };
    deletion.deleteLeaf.calledWith(CALLER.id, 'l1').mockResolvedValue({ ok: true, value: { scope, stoppedRun: true } });
    expect(await del(router, '/l1')).toEqual({ status: 200, body: { success: true, stoppedRun: true, deleted: scope } });
    deletion.deleteLeaf.calledWith(CALLER.id, 'gone').mockResolvedValue({ ok: false, status: 404, error: 'Leaf not found' });
    expect(await del(router, '/gone')).toEqual({ status: 404, body: { error: 'Leaf not found' } });
  });
});
