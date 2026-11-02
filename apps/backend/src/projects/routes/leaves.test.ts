import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type RouteAnswer } from '../../platform/testing/routes.js';
import type { Leaf } from '../lib/leaves.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { GroveRunService } from '../services/GroveRunService.js';
import { leavesRouter } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: TEST_USER.id, branchId: 'b1', title: 'do a thing', status: 'pending', createdAt: 't', updatedAt: 't', ...over,
});

const plain = ({ status, data }: RouteAnswer) => ({ status, body: data });

async function setUp() {
  const db = memoryDatabase();
  const runs = mock<GroveRunService>();
  const deletion = mock<GroveDeletionService>();
  const router = leavesRouter({ db: db.projects, runs, deletion });
  const routes = await routesInProcess({ prefix: '/', router: () => router, db });
  return { db, runs, deletion, routes };
}

describe('listing leaves', () => {
  it('shows only the caller\'s leaves, optionally one branch\'s', async () => {
    const { db, routes } = await setUp();
    await db.projects.saveLeaf(leaf({ id: 'mine' }));
    await db.projects.saveLeaf(leaf({ id: 'other-branch', branchId: 'b2' }));
    await db.projects.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else' }));
    expect(((await routes.get('/')).data as Leaf[]).map((entry) => entry.id)).toEqual(['mine', 'other-branch']);
    expect(((await routes.get('/?branchId=b2')).data as Leaf[]).map((entry) => entry.id)).toEqual(['other-branch']);
  });

  it('answers with the error rather than hanging when the database throws', async () => {
    const router = leavesRouter({ db: { getLeaves: async () => { throw new Error('db is down'); } }, runs: mock<GroveRunService>(), deletion: mock<GroveDeletionService>() });
    const routes = await routesInProcess({ prefix: '/', router: () => router });
    expect(plain(await routes.get('/'))).toEqual({ status: 500, body: { error: 'db is down' } });
  });
});

describe('acting on one leaf', () => {
  it('answers 404 for another owner\'s leaf on every route that takes an id, calling no service', async () => {
    const { db, runs, routes } = await setUp();
    await db.projects.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else', status: 'failed' }));
    const answers = [
      await routes.post('/theirs/retry', {}),
      await routes.post('/theirs/settle', { verdict: 'verified' }),
      await routes.post('/theirs/cancel', {}),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404]);
    expect(runs.retryLeaf).not.toHaveBeenCalled();
    expect(runs.settleClaim).not.toHaveBeenCalled();
    expect(runs.cancelLeaf).not.toHaveBeenCalled();
  });

  it('retries the caller\'s leaf and answers what the run service answers, a refusal with its status', async () => {
    const { db, runs, routes } = await setUp();
    const failed = leaf({ status: 'failed' });
    await db.projects.saveLeaf(failed);
    runs.retryLeaf.calledWith(TEST_USER.id, matches<Leaf>((given) => given.id === 'l1')).mockResolvedValueOnce({ ok: true, value: { ...failed, status: 'pending' } });
    expect(await routes.post('/l1/retry', {})).toMatchObject({ status: 200, data: { id: 'l1', status: 'pending' } });
    runs.retryLeaf.mockResolvedValueOnce({ ok: false, status: 409, error: 'Only a failed leaf can be retried' });
    expect(plain(await routes.post('/l1/retry', {}))).toEqual({ status: 409, body: { error: 'Only a failed leaf can be retried' } });
  });

  it('settles with a verdict and a trimmed note, and refuses any other verdict before asking the service', async () => {
    const { db, runs, routes } = await setUp();
    await db.projects.saveLeaf(leaf());
    runs.settleClaim.mockResolvedValue({ ok: true, value: leaf({ status: 'succeeded' }) });
    expect(await routes.post('/l1/settle', { verdict: 'verified', note: '  looks right ' })).toMatchObject({ status: 200, data: { status: 'succeeded' } });
    expect(runs.settleClaim).toHaveBeenCalledWith(matches<Leaf>((given) => given.id === 'l1'), 'verified', 'looks right');
    expect(plain(await routes.post('/l1/settle', { verdict: 'maybe' }))).toEqual({ status: 400, body: { error: "verdict is 'verified' or 'failed'" } });
    expect(runs.settleClaim).toHaveBeenCalledTimes(1);
    runs.settleClaim.mockResolvedValueOnce({ ok: false, status: 409, error: 'Nothing is claimed' });
    expect(plain(await routes.post('/l1/settle', { verdict: 'failed' }))).toEqual({ status: 409, body: { error: 'Nothing is claimed' } });
  });

  it('cancels the caller\'s leaf and passes on a refusal', async () => {
    const { db, runs, routes } = await setUp();
    await db.projects.saveLeaf(leaf());
    runs.cancelLeaf.mockResolvedValueOnce({ ok: true, value: leaf({ status: 'cancelled' }) });
    expect(await routes.post('/l1/cancel', {})).toMatchObject({ status: 200, data: { status: 'cancelled' } });
    runs.cancelLeaf.mockResolvedValueOnce({ ok: false, status: 409, error: 'Only unfinished work can be cancelled' });
    expect(plain(await routes.post('/l1/cancel', {}))).toEqual({ status: 409, body: { error: 'Only unfinished work can be cancelled' } });
  });

  it('deletes through the deletion service as the caller and reports what went', async () => {
    const { deletion, routes } = await setUp();
    const scope = { treeId: undefined, branchIds: [], leafIds: ['l1'], taskIds: [], proposalIds: [], conversationIds: [], adoptingProposalIds: [] };
    deletion.deleteLeaf.calledWith(TEST_USER.id, 'l1').mockResolvedValue({ ok: true, value: { scope, stoppedRun: true } });
    expect(plain(await routes.delete('/l1'))).toEqual({ status: 200, body: { success: true, stoppedRun: true, deleted: scope } });
    deletion.deleteLeaf.calledWith(TEST_USER.id, 'gone').mockResolvedValue({ ok: false, status: 404, error: 'Leaf not found' });
    expect(plain(await routes.delete('/gone'))).toEqual({ status: 404, body: { error: 'Leaf not found' } });
  });
});
