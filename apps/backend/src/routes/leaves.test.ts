import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { leavesRouter } from './leaves.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { GroveRunService } from '../services/GroveRunService.js';
import { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { Database } from '../lib/db-interface.js';

const deletionFor = (db: Database, terminated: string[] = [], released: string[] = []) => new GroveDeletionService({
  store: db,
  workflows: { terminate: async (workflowId: string) => { terminated.push(workflowId); return false; } },
  workspaces: { release: async (treeId: string) => { released.push(treeId); } },
});

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const launcher = {
  startGroveRun: vi.fn(async () => ({ started: true as const, workflowId: 'grove-run-t1' })),
  groveRunStatus: vi.fn(async () => ({ state: 'running' as const, startedAt: 'then' })),
  signalGroveRun: vi.fn(async () => true),
};

const mount = async (user: typeof TEST_USER | null = TEST_USER) => {
  h = await mountRouter({
    prefix: '/api/leaves',
    user,
    router: (db) => leavesRouter({ db, runs: new GroveRunService({ store: db, launcher }), deletion: deletionFor(db) }),
  });
  return h!;
};

const leaf = (over: Record<string, unknown> = {}) => ({
  id: 'l1', ownerId: TEST_USER.id, branchId: 'b1', title: 'do a thing', status: 'pending',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...over,
});

describe('listing leaves', () => {
  it('shows only the caller\'s leaves, optionally one branch\'s', async () => {
    const harness = await mount();
    await harness.db.saveLeaf(leaf({ id: 'mine' }) as never);
    await harness.db.saveLeaf(leaf({ id: 'other-branch', branchId: 'b2' }) as never);
    await harness.db.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else' }) as never);
    expect((await axios.get(harness.url('/api/leaves'))).data.map((l: { id: string }) => l.id)).toEqual(['mine', 'other-branch']);
    expect((await axios.get(harness.url('/api/leaves?branchId=b2'))).data.map((l: { id: string }) => l.id)).toEqual(['other-branch']);
  });

  it('refuses an unauthenticated caller', async () => {
    const harness = await mount(null);
    await expect(axios.get(harness.url('/api/leaves'))).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('answers rather than hanging when a dependency throws', async () => {
    h = await mountRouter({
      prefix: '/api/leaves',
      router: () => leavesRouter({ db: { getLeaves: async () => { throw new Error('db is down'); } }, runs: {} as never, deletion: {} as never }),
    });
    await expect(axios.get(h.url('/api/leaves'), { timeout: 3000 })).rejects.toMatchObject({ response: { status: 500, data: { error: 'db is down' } } });
  });
});

describe('acting on one leaf', () => {
  it('404s another tenant\'s leaf on every route that takes an id', async () => {
    const harness = await mount();
    await harness.db.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else', status: 'failed' }) as never);
    const calls: [string, () => Promise<unknown>][] = [
      ['retry', () => axios.post(harness.url('/api/leaves/theirs/retry'), {})],
      ['settle', () => axios.post(harness.url('/api/leaves/theirs/settle'), { verdict: 'verified' })],
      ['cancel', () => axios.post(harness.url('/api/leaves/theirs/cancel'), {})],
      ['delete', () => axios.delete(harness.url('/api/leaves/theirs'))],
    ];
    for (const [name, call] of calls) {
      const err = await call().catch((e: { response?: { status?: number } }) => e);
      expect((err as { response?: { status?: number } }).response?.status, name).toBe(404);
    }
    expect((await harness.db.getLeaves()).find((l) => l.id === 'theirs')?.status).toBe('failed');
  });
});

describe('settling a claim a judge kept for a person', () => {
  const parked = (over: Record<string, unknown> = {}) => leaf({
    id: 'p1', status: 'claimed',
    claim: { evidence: 'curl answered 200', commit: 'c0ffee', at: '2026-09-24T00:00:00.000Z' },
    review: { verdict: 'concern', reason: 'the port was never probed', at: '2026-09-24T00:01:00.000Z' },
    ...over,
  });

  it('verifies it, and the leaf succeeds', async () => {
    const harness = await mount();
    await harness.db.saveLeaf(parked() as never);

    const res = await axios.post(harness.url('/api/leaves/p1/settle'), { verdict: 'verified', note: 'checked it myself' });

    expect(res.data).toMatchObject({ status: 'succeeded', verified: true, findings: 'checked it myself', review: { verdict: 'sound', model: 'person', reason: 'checked it myself' } });
  });

  it('fails it only with a reason, which the replan will read', async () => {
    const harness = await mount();
    await harness.db.saveLeaf(parked() as never);

    const bare = await axios.post(harness.url('/api/leaves/p1/settle'), { verdict: 'failed' }).catch((e) => e);
    expect(bare.response.status).toBe(409);
    expect(bare.response.data.error).toMatch(/needs a reason/);

    const res = await axios.post(harness.url('/api/leaves/p1/settle'), { verdict: 'failed', note: 'serves the wrong page' });
    expect(res.data).toMatchObject({ status: 'failed', verified: false, findings: 'serves the wrong page' });
  });

  it('refuses a leaf that is not waiting for judgment, a verdict that is not one, and another owner\'s leaf', async () => {
    const harness = await mount();
    await harness.db.saveLeaf(parked({ id: 'done', status: 'succeeded' }) as never);
    await harness.db.saveLeaf(parked({ id: 'theirs', ownerId: 'someone-else' }) as never);
    await harness.db.saveLeaf(parked() as never);

    const statusOf = (id: string, body: unknown) => axios.post(harness.url(`/api/leaves/${id}/settle`), body).then(() => 200, (e) => e.response.status);
    expect(await statusOf('done', { verdict: 'verified' })).toBe(409);
    expect(await statusOf('p1', { verdict: 'stay-claimed' })).toBe(400);
    expect(await statusOf('theirs', { verdict: 'verified' })).toBe(404);
  });
});

describe('retrying a failed engine leaf', () => {
  it('resets the leaf and its failed tasks, records the attempt, and runs the tree on the engine', async () => {
    const launcher = {
      startGroveRun: vi.fn(async () => ({ started: true as const, workflowId: 'grove-run-t1' })),
      groveRunStatus: vi.fn(async () => ({ state: 'running' as const, startedAt: 'then' })),
      signalGroveRun: vi.fn(async () => true),
    };
    h = await mountRouter({
      prefix: '/api/leaves',
      router: (db) => leavesRouter({ db, runs: new GroveRunService({ store: db, launcher, now: () => 'later' }), deletion: deletionFor(db) }),
    });
    await h.db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'B', createdAt: 'now', updatedAt: 'now' } as never);
    await h.db.saveLeaf(leaf({ id: 'e1', status: 'failed', findings: 'test.sh exits 1', claim: { evidence: 'ran it', at: 'then' } }) as never);
    await h.db.saveTask({ id: 'k1', ownerId: TEST_USER.id, leafId: 'e1', title: 'Write test.sh', doneMeans: 'it exits 0', dependsOn: [], status: 'failed', runs: [], createdAt: 'now', updatedAt: 'now' } as never);
    await h.db.saveTask({ id: 'k2', ownerId: TEST_USER.id, leafId: 'e1', title: 'Write greet.js', doneMeans: 'it greets', dependsOn: [], status: 'done', runs: [], createdAt: 'now', updatedAt: 'now' } as never);

    const res = await axios.post(h.url('/api/leaves/e1/retry'));

    expect(res.data).toMatchObject({ status: 'pending', attempts: [{ attempt: 1, error: 'test.sh exits 1' }] });
    expect(res.data.claim).toBeUndefined();
    expect((await h.db.getTasks(TEST_USER.id)).map((task) => [task.id, task.status]).sort()).toEqual([['k1', 'accepted'], ['k2', 'done']]);
    expect(launcher.startGroveRun).toHaveBeenCalledWith(TEST_USER.id, 't1');
  });

  it('refuses a leaf that has not failed', async () => {
    const harness = await mount();
    await harness.db.saveLeaf(leaf({ id: 'busy', status: 'running' }) as never);
    const err = await axios.post(harness.url('/api/leaves/busy/retry')).catch((e) => e);
    expect(err.response.status).toBe(409);
  });
});

describe('cancelling a leaf', () => {
  it('cancels unfinished work and tells the tree\'s run, and refuses finished work', async () => {
    const harness = await mount();
    await harness.db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'B', createdAt: 'now', updatedAt: 'now' });
    await harness.db.saveLeaf(leaf({ id: 'live', status: 'running' }) as never);
    await harness.db.saveLeaf(leaf({ id: 'done', status: 'succeeded' }) as never);

    const res = await axios.post(harness.url('/api/leaves/live/cancel'));
    expect(res.data).toMatchObject({ id: 'live', status: 'cancelled' });
    expect(launcher.signalGroveRun).toHaveBeenCalledWith('t1', 'cancelLeaf', 'live');
    const err = await axios.post(harness.url('/api/leaves/done/cancel')).catch((e) => e);
    expect(err.response.status).toBe(409);
  });
});

describe('deleting a leaf', () => {
  it('takes its tasks and its leaf plans, and stops the tree\'s run', async () => {
    const terminated: string[] = [];
    h = await mountRouter({
      prefix: '/api/leaves',
      router: (db) => leavesRouter({ db, runs: new GroveRunService({ store: db, launcher }), deletion: deletionFor(db, terminated) }),
    });
    const db = h.db;
    await db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'B', createdAt: 'now', updatedAt: 'now' } as never);
    await db.saveLeaf(leaf({ id: 'l1' }) as never);
    await db.saveLeaf(leaf({ id: 'l2' }) as never);
    await db.saveTask({ id: 'k1', ownerId: TEST_USER.id, leafId: 'l1', title: 'T', doneMeans: 'd', dependsOn: [], status: 'accepted', runs: [], createdAt: 'now', updatedAt: 'now' } as never);
    await db.saveTask({ id: 'k2', ownerId: TEST_USER.id, leafId: 'l2', title: 'T', doneMeans: 'd', dependsOn: [], status: 'accepted', runs: [], createdAt: 'now', updatedAt: 'now' } as never);
    await db.savePlanProposal({ id: 'p1', ownerId: TEST_USER.id, status: 'proposed', leafPlan: { treeId: 't1', leafId: 'l1', leafTitle: 'L', mode: 'replan', why: 'w', brief: 'b', tasks: [] }, createdAt: 'now', updatedAt: 'now' });

    await axios.delete(h.url('/api/leaves/l1'));

    expect((await db.getLeaves()).map((l) => l.id)).toEqual(['l2']);
    expect((await db.getTasks(TEST_USER.id)).map((t) => t.id)).toEqual(['k2']);
    expect(await db.getPlanProposals(TEST_USER.id)).toEqual([]);
    expect(terminated).toEqual(['grove-run-t1']);
  });
});
