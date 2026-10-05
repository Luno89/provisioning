import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { treesRouter } from './trees.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { GroveRunService } from '../services/GroveRunService.js';
import { GroveDeletionService } from '../services/GroveDeletionService.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const terminate = vi.fn(async (_workflowId: string, _reason: string) => true);
const workspaces = {
  state: vi.fn(async (_treeId: string) => 'parked' as const),
  release: vi.fn(async (_treeId: string, _ownerId: string) => ({ saved: false as const, why: 'no documents in this test' })),
};

let running = false;
const launcher = {
  startGroveRun: vi.fn(async (_ownerId: string, _treeId: string) => {
    if (running) return { started: false as const, reason: 'running' as const };
    running = true;
    return { started: true as const, workflowId: 'grove-run-t1' };
  }),
  groveRunStatus: vi.fn(async () => (running ? { state: 'running' as const, startedAt: 'then' } : { state: 'none' as const })),
  signalGroveRun: vi.fn(async (_treeId: string, _signal: string) => running),
};

const mount = async (): Promise<Harness> => {
  workspaces.state.mockClear();
  workspaces.release.mockClear();
  launcher.startGroveRun.mockClear();
  running = false;
  h = await mountRouter({
    prefix: '/api/trees',
    router: (db) => treesRouter({ db, workspaces, runs: new GroveRunService({ store: db, launcher }), deletion: new GroveDeletionService({ store: db, workflows: { terminate: terminate }, workspaces }) }),
  });
  return h!;
};

const tree = (over: Record<string, unknown> = {}) => ({
  id: 't1', ownerId: TEST_USER.id, name: 'widget', type: 'api-service', projectIds: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...over,
});

describe('a tree\'s workspace', () => {
  it('reports the state of the tree\'s sandbox', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    const res = await axios.get(harness.url('/api/trees/t1/workspace'));
    expect(res.data).toEqual({ state: 'parked' });
    expect(workspaces.state).toHaveBeenCalledWith('t1');
  });

  it('releases the sandbox on request, and never another owner\'s', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    await harness.db.saveTree(tree({ id: 't2', ownerId: 'someone-else' }) as never);

    const res = await axios.delete(harness.url('/api/trees/t1/workspace'));
    expect(res.data).toEqual({ state: 'none' });
    await expect(axios.delete(harness.url('/api/trees/t2/workspace'))).rejects.toMatchObject({ response: { status: 404 } });
    expect(workspaces.release.mock.calls).toEqual([['t1', TEST_USER.id]]);
  });

  it('deleting a tree takes everything about it: its run, branches, leaves, tasks, plans, conversations and sandbox', async () => {
    const harness = await mount();
    terminate.mockClear();
    const db = harness.db;
    const stamp = 'now';
    await db.saveTree(tree() as never);
    await db.saveTree(tree({ id: 'keep' }) as never);
    await db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'B', createdAt: stamp, updatedAt: stamp } as never);
    await db.saveBranch({ id: 'b-keep', ownerId: TEST_USER.id, treeId: 'keep', title: 'B', createdAt: stamp, updatedAt: stamp } as never);
    await db.saveLeaf({ id: 'l1', ownerId: TEST_USER.id, branchId: 'b1', title: 'L', status: 'pending', createdAt: stamp, updatedAt: stamp } as never);
    await db.saveLeaf({ id: 'l-keep', ownerId: TEST_USER.id, branchId: 'b-keep', title: 'L', status: 'pending', createdAt: stamp, updatedAt: stamp } as never);
    await db.saveTask({ id: 'k1', ownerId: TEST_USER.id, leafId: 'l1', title: 'T', doneMeans: 'd', dependsOn: [], status: 'accepted', runs: [], createdAt: stamp, updatedAt: stamp } as never);
    await db.saveConversation({ id: 'c1', ownerId: TEST_USER.id, title: 'about t1', treeId: 't1', messages: [], createdAt: stamp, updatedAt: stamp });
    await db.savePlanProposal({ id: 'p1', ownerId: TEST_USER.id, status: 'adopting', leafPlan: { treeId: 't1', leafId: 'l1', leafTitle: 'L', mode: 'replan', why: 'w', brief: 'b', tasks: [] }, createdAt: stamp, updatedAt: stamp });

    const res = await axios.delete(harness.url('/api/trees/t1'));

    expect(res.data).toMatchObject({ success: true, stoppedRun: true });
    expect(terminate.mock.calls.map(([id]) => id)).toEqual(['grove-run-t1', 'adopt-plan-p1']);
    expect(workspaces.release.mock.calls).toEqual([['t1', TEST_USER.id]]);
    expect((await db.getTrees()).map((t) => t.id)).toEqual(['keep']);
    expect((await db.getBranches()).map((b) => b.id)).toEqual(['b-keep']);
    expect((await db.getLeaves()).map((l) => l.id)).toEqual(['l-keep']);
    expect(await db.getTasks(TEST_USER.id)).toEqual([]);
    expect(await db.getConversation(TEST_USER.id, 'c1')).toBeUndefined();
    expect(await db.getPlanProposals(TEST_USER.id)).toEqual([]);
  });

  it('deletes nothing when the tree\'s repository could not be saved first', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    const stamp = new Date().toISOString();
    await harness.db.saveLeaf({ id: 'l1', ownerId: TEST_USER.id, branchId: 'b1', title: 'L', status: 'pending', createdAt: stamp, updatedAt: stamp } as never);
    workspaces.release.mockRejectedValueOnce(new Error('Pushing to koala-u1/tree-t1 failed: Gitea is down'));

    const err = await axios.delete(harness.url('/api/trees/t1')).catch((e) => e);

    expect(err.response.status).toBe(500);
    expect((await harness.db.getTrees()).map((t) => t.id)).toEqual(['t1']);
    expect((await harness.db.getLeaves()).map((l) => l.id)).toEqual(['l1']);
  });

  it('refuses to delete another owner\'s tree and touches nothing', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree({ ownerId: 'someone-else' }) as never);
    const err = await axios.delete(harness.url('/api/trees/t1')).catch((e) => e);
    expect(err.response.status).toBe(404);
    expect(await harness.db.getTrees()).toHaveLength(1);
  });
});

describe('running a tree on the engine', () => {
  const branch = { id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'B', createdAt: 'now', updatedAt: 'now' };
  const leafOf = (over: Record<string, unknown> = {}) => ({
    id: 'l1', ownerId: TEST_USER.id, branchId: 'b1', title: 'L', status: 'pending',
    createdAt: 'now', updatedAt: 'now', ...over,
  });

  it('starts one run for a planned tree, and reports it running', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    await harness.db.saveBranch(branch as never);
    await harness.db.saveLeaf(leafOf() as never);

    const first = await axios.post(harness.url('/api/trees/t1/run'));
    const second = await axios.post(harness.url('/api/trees/t1/run'));
    const status = await axios.get(harness.url('/api/trees/t1/run'));

    expect(first.status).toBe(202);
    expect(first.data).toMatchObject({ state: 'running' });
    expect(second.data).toMatchObject({ state: 'running' });
    expect(launcher.startGroveRun).toHaveBeenCalledWith(TEST_USER.id, 't1');
    expect(status.data).toMatchObject({ state: 'running' });
  });

  it('refuses an empty tree and another owner\'s, and stops a running one', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    await harness.db.saveTree(tree({ id: 't2', ownerId: 'someone-else' }) as never);

    const empty = await axios.post(harness.url('/api/trees/t1/run')).catch((e) => e);
    expect(empty.response.status).toBe(409);
    expect(empty.response.data.error).toMatch(/Nothing is planned/);
    expect((await axios.post(harness.url('/api/trees/t2/run')).catch((e) => e)).response.status).toBe(404);
    expect(launcher.startGroveRun).not.toHaveBeenCalled();

    const idle = await axios.post(harness.url('/api/trees/t1/run/stop')).catch((e) => e);
    expect(idle.response.status).toBe(409);
    await harness.db.saveBranch(branch as never);
    await harness.db.saveLeaf(leafOf() as never);
    await axios.post(harness.url('/api/trees/t1/run'));
    await axios.post(harness.url('/api/trees/t1/run/stop'));
    expect(launcher.signalGroveRun).toHaveBeenCalledWith('t1', 'stopRun');
  });
});

