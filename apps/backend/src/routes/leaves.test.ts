import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { leavesRouter } from './leaves.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { LEAF_COLUMNS } from '../lib/leaves.js';
import { GroveRunService } from '../services/GroveRunService.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const bridge = () => ({
  signalLeaf: vi.fn(async () => undefined),
  cancelLeaf: vi.fn(async () => undefined),
  terminateLeaf: vi.fn(async () => undefined),
}) as never;

const mount = async (user: typeof TEST_USER | null = TEST_USER) => {
  h = await mountRouter({
    prefix: '/api/leaves',
    user,
    router: (db) => leavesRouter({ db, temporalBridge: bridge(), giteaService: {} as never }),
  });
  return h!;
};

const leaf = (over: Record<string, unknown> = {}) => ({
  id: 'l1', ownerId: TEST_USER.id, branchId: 'b1', title: 'do a thing',
  column: 'todo', status: 'todo', depth: 0, blocking: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...over,
});

describe('listing the board', () => {
  it('shows only the caller\'s leaves', async () => {
    const harness = await mount();
    await harness.db.saveLeaf(leaf({ id: 'mine' }) as never);
    await harness.db.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else' }) as never);
    const res = await axios.get(harness.url('/api/leaves'));
    expect(res.data.map((l: { id: string }) => l.id)).toEqual(['mine']);
  });

  it('refuses an unauthenticated caller', async () => {
    const harness = await mount(null);
    await expect(axios.get(harness.url('/api/leaves'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});

describe('which leaves are frozen', () => {
  it('marks every leaf the old pipeline made, and none of the engine\'s in an open tree', async () => {
    const harness = await mount();
    await harness.db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'B', messages: [], createdAt: 'now', updatedAt: 'now' } as never);
    await harness.db.saveBranch({ id: 'b2', ownerId: TEST_USER.id, treeId: 't2', title: 'B', messages: [], createdAt: 'now', updatedAt: 'now' } as never);
    await harness.db.saveLeaf(leaf({ id: 'old', branchId: 'b1' }) as never);
    await harness.db.saveLeaf(leaf({ id: 'new', branchId: 'b2', runner: 'engine' }) as never);
    const listed = (await axios.get(harness.url('/api/leaves'))).data as { id: string; frozen: boolean }[];
    expect(Object.fromEntries(listed.map((entry) => [entry.id, entry.frozen]))).toEqual({ old: true, new: false });
  });
});

describe('acting on one leaf', () => {
  it('404s another tenant\'s leaf on every route that takes an id', async () => {
    const harness = await mount();
    await harness.db.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else' }) as never);
    const calls: [string, () => Promise<unknown>][] = [
      ['accept', () => axios.post(harness.url('/api/leaves/theirs/accept'), {})],
      ['review', () => axios.post(harness.url('/api/leaves/theirs/review'), {})],
      ['retry', () => axios.post(harness.url('/api/leaves/theirs/retry'), {})],
      ['recheck', () => axios.post(harness.url('/api/leaves/theirs/recheck'), {})],
      ['cancel', () => axios.post(harness.url('/api/leaves/theirs/cancel'), {})],
      ['trace', () => axios.get(harness.url('/api/leaves/theirs/trace'))],
      ['explain', () => axios.get(harness.url('/api/leaves/theirs/explain'))],
      ['patch', () => axios.patch(harness.url('/api/leaves/theirs'), { title: 'hijacked' })],
      ['delete', () => axios.delete(harness.url('/api/leaves/theirs'))],
    ];
    for (const [name, call] of calls) {
      const err = await call().catch((e: { response?: { status?: number } }) => e);
      expect((err as { response?: { status?: number } }).response?.status, name).toBe(404);
    }
    const stored = (await harness.db.getLeaves()).find((l) => l.id === 'theirs');
    expect(stored?.title).toBe('do a thing');
  });

  describe('explaining what will happen', () => {
    const treeType = (over: Record<string, unknown> = {}) => ({
      id: 'widget', ownerId: TEST_USER.id, label: 'Widget', summary: 'A widget.',
      language: 'node', produces: 'service', doneMeans: 'It works.', files: [],
      ...over,
    });

    it('falls back to defaults when the leaf resolves to no tree type', async () => {
      const harness = await mount();
      await harness.db.saveLeaf(leaf({ status: 'todo' }) as never);
      const res = await axios.get(harness.url('/api/leaves/l1/explain'));
      expect(res.data.treeType).toBeUndefined();
      expect(res.data.roles).toEqual({});
      expect(res.data.leafWorkflow.onSuccess.map((n: { stage: string }) => n.stage))
        .toEqual(['release', 'judge', 'land', 'resolve', 'accept', 'replan']);
      expect(res.data.autoAccept.policy.enabled).toBe(false);
      expect(res.data.autoAccept.verdict).toEqual({ accept: false, reason: 'not a proposal' });
    });

    it('resolves tree type, roles, recipe, workflow, and an accept verdict for a proposed leaf', async () => {
      const harness = await mount();
      await harness.db.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'Tree', type: 'widget' } as never);
      await harness.db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'Branch', messages: [], autoAccept: true, createdAt: '', updatedAt: '' } as never);
      await harness.db.savePersonaPack({
        id: 'pack-1', ownerId: TEST_USER.id, slug: 'builder', name: 'Builder', personaId: 'p1', personaName: 'Builder',
        tools: [], canRunLeaf: true, sampling: { toolTurn: {}, conversation: {} }, budget: {} as never,
        prompt: { sections: {} }, createdAt: '', updatedAt: '',
      } as never);
      await harness.db.saveTreeType(treeType({
        packs: { planner: 'builder' },
        validationRecipe: { type: 'command', checks: [{ id: 'c1', name: 'Check', type: 'run-command', command: 'true' }] },
        autoAccept: { enabled: true, minTitleChars: 1, minBodyChars: 1, requirePersona: true },
      }) as never);
      await harness.db.saveLeaf(leaf({
        status: 'proposed', title: 'A proposed leaf', body: 'Enough detail here.', packId: 'pack-1',
      }) as never);

      const res = await axios.get(harness.url('/api/leaves/l1/explain'));
      expect(res.data.treeType).toMatchObject({ id: 'widget', label: 'Widget' });
      expect(res.data.roles.planner).toMatchObject({ id: 'pack-1', slug: 'builder' });
      expect(res.data.roles.judge).toBeUndefined();
      expect(res.data.validationRecipe.checks).toHaveLength(1);
      expect(res.data.autoAccept.policy.enabled).toBe(true);
      expect(res.data.autoAccept.verdict).toEqual({ accept: true, reason: 'well-formed, assigned and not already being done' });
    });

    it('an explicit branch override wins over the tree type\'s auto-accept default', async () => {
      const harness = await mount();
      await harness.db.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'Tree', type: 'widget' } as never);
      await harness.db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'Branch', messages: [], autoAccept: false, createdAt: '', updatedAt: '' } as never);
      await harness.db.saveTreeType(treeType({ autoAccept: { enabled: true } }) as never);
      await harness.db.saveLeaf(leaf({ status: 'proposed', title: 'A proposed leaf', body: 'Enough detail here.' }) as never);

      const res = await axios.get(harness.url('/api/leaves/l1/explain'));
      expect(res.data.autoAccept.policy.enabled).toBe(false);
    });
  });

  it('answers rather than hanging when a dependency throws', async () => {
    const harness = await mountRouter({
      prefix: '/api/leaves',
      router: () => leavesRouter({
        db: { getLeaves: async () => { throw new Error('db is down'); } } as never,
        temporalBridge: bridge(),
        giteaService: {} as never,
      }),
    });
    h = harness;
    await expect(axios.get(harness.url('/api/leaves'), { timeout: 3000 })).rejects.toMatchObject({
      response: { status: 500, data: { error: 'db is down' } },
    });
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
    const legacy = bridge();
    const launcher = {
      startGroveRun: vi.fn(async () => ({ started: true as const, workflowId: 'grove-run-t1' })),
      groveRunStatus: vi.fn(async () => ({ state: 'running' as const, startedAt: 'then' })),
    };
    h = await mountRouter({
      prefix: '/api/leaves',
      router: (db) => leavesRouter({ db, temporalBridge: legacy as never, giteaService: {} as never, runs: new GroveRunService({ store: db, launcher, now: () => 'later' }) }),
    });
    await h.db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'B', messages: [], createdAt: 'now', updatedAt: 'now' } as never);
    await h.db.saveLeaf(leaf({ id: 'e1', status: 'failed', runner: 'engine', findings: 'test.sh exits 1', claim: { evidence: 'ran it', at: 'then' } }) as never);
    await h.db.saveTask({ id: 'k1', ownerId: TEST_USER.id, leafId: 'e1', title: 'Write test.sh', doneMeans: 'it exits 0', dependsOn: [], status: 'failed', runs: [], createdAt: 'now', updatedAt: 'now' } as never);
    await h.db.saveTask({ id: 'k2', ownerId: TEST_USER.id, leafId: 'e1', title: 'Write greet.js', doneMeans: 'it greets', dependsOn: [], status: 'done', runs: [], createdAt: 'now', updatedAt: 'now' } as never);

    const res = await axios.post(h.url('/api/leaves/e1/retry'));

    expect(res.data).toMatchObject({ status: 'pending', attempts: [{ attempt: 1, error: 'test.sh exits 1' }] });
    expect(res.data.claim).toBeUndefined();
    expect((await h.db.getTasks(TEST_USER.id)).map((task) => [task.id, task.status]).sort()).toEqual([['k1', 'accepted'], ['k2', 'done']]);
    expect(launcher.startGroveRun).toHaveBeenCalledWith(TEST_USER.id, 't1');
  });

  it('refuses to retry or edit a leaf the old pipeline made, or an engine leaf in a tree it froze', async () => {
    const launcher = { startGroveRun: vi.fn(), groveRunStatus: vi.fn() };
    h = await mountRouter({
      prefix: '/api/leaves',
      router: (db) => leavesRouter({ db, temporalBridge: bridge(), giteaService: {} as never, runs: new GroveRunService({ store: db, launcher: launcher as never }) }),
    });
    await h.db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'B', messages: [], createdAt: 'now', updatedAt: 'now' } as never);
    await h.db.saveLeaf(leaf({ id: 'old', status: 'failed' }) as never);
    await h.db.saveLeaf(leaf({ id: 'mixed', status: 'failed', runner: 'engine' }) as never);

    for (const id of ['old', 'mixed']) {
      for (const call of [() => axios.post(h!.url(`/api/leaves/${id}/retry`)), () => axios.patch(h!.url(`/api/leaves/${id}`), { title: 'changed' })]) {
        const err = await call().catch((e: { response?: { status?: number; data?: { error?: string } } }) => e);
        expect((err as { response?: { status?: number } }).response?.status, id).toBe(409);
        expect((err as { response?: { data?: { error?: string } } }).response?.data?.error).toMatch(/frozen/);
      }
    }
    expect(launcher.startGroveRun).not.toHaveBeenCalled();
    expect((await h.db.getLeaves()).find((l) => l.id === 'old')?.title).toBe('do a thing');
  });
});

