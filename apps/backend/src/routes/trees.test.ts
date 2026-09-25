import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { treesRouter } from './trees.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { GroveRunService } from '../services/GroveRunService.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const workspaces = {
  state: vi.fn(async (_treeId: string) => 'parked' as const),
  release: vi.fn(async (_treeId: string) => undefined),
};

let running = false;
const launcher = {
  startGroveRun: vi.fn(async (_ownerId: string, _treeId: string) => {
    if (running) return { started: false as const, reason: 'running' as const };
    running = true;
    return { started: true as const, workflowId: 'grove-run-t1' };
  }),
  groveRunStatus: vi.fn(async () => (running ? { state: 'running' as const, startedAt: 'then' } : { state: 'none' as const })),
};

const mount = async (): Promise<Harness> => {
  workspaces.state.mockClear();
  workspaces.release.mockClear();
  launcher.startGroveRun.mockClear();
  running = false;
  h = await mountRouter({
    prefix: '/api/trees',
    router: (db) => treesRouter({ db, temporalBridge: {} as never, workspaces, runs: new GroveRunService({ store: db, launcher }) }),
  });
  return h!;
};

const tree = (over: Record<string, unknown> = {}) => ({
  id: 't1', ownerId: TEST_USER.id, name: 'widget', type: 'api-service', projectIds: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...over,
});

const project = (over: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'widget', ownerId: TEST_USER.id, giteaOwner: 'acme', giteaRepo: 'widget',
  appType: 'gitapp', createdAt: new Date().toISOString(),
  ...over,
});

describe('PATCH /trees/:id', () => {
  it('updates name and goal', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    const res = await axios.patch(harness.url('/api/trees/t1'), { name: 'renamed', goal: 'new goal' });
    expect(res.data).toMatchObject({ name: 'renamed', goal: 'new goal' });
  });

  it('links an owned project via projectId', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    await harness.db.saveProjectInfo(project() as never);
    const res = await axios.patch(harness.url('/api/trees/t1'), { projectId: 'p1' });
    expect(res.data.projectIds).toEqual(['p1']);
  });

  it('is idempotent — linking the same project twice does not duplicate it', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree({ projectIds: ['p1'] }) as never);
    await harness.db.saveProjectInfo(project() as never);
    const res = await axios.patch(harness.url('/api/trees/t1'), { projectId: 'p1' });
    expect(res.data.projectIds).toEqual(['p1']);
  });

  it('refuses to link a project owned by someone else', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    await harness.db.saveProjectInfo(project({ id: 'p2', ownerId: 'someone-else' }) as never);
    const err = await axios.patch(harness.url('/api/trees/t1'), { projectId: 'p2' }).catch((e) => e);
    expect(err.response.status).toBe(400);
    const stored = (await harness.db.getTrees()).find((t: { id: string }) => t.id === 't1');
    expect(stored?.projectIds).toEqual([]);
  });

  it('refuses a nonexistent projectId', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    const err = await axios.patch(harness.url('/api/trees/t1'), { projectId: 'ghost' }).catch((e) => e);
    expect(err.response.status).toBe(400);
  });

  it('404s a tree owned by someone else', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree({ id: 'theirs', ownerId: 'someone-else' }) as never);
    const err = await axios.patch(harness.url('/api/trees/theirs'), { name: 'hijacked' }).catch((e) => e);
    expect(err.response.status).toBe(404);
  });
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
    expect(workspaces.release.mock.calls).toEqual([['t1']]);
  });

  it('releases the sandbox when the tree itself is deleted', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    await axios.delete(harness.url('/api/trees/t1'));
    expect(workspaces.release.mock.calls).toEqual([['t1']]);
  });
});

describe('running a tree on the engine', () => {
  const branch = { id: 'b1', ownerId: TEST_USER.id, treeId: 't1', title: 'B', messages: [], createdAt: 'now', updatedAt: 'now' };
  const leafOf = (over: Record<string, unknown> = {}) => ({
    id: 'l1', ownerId: TEST_USER.id, branchId: 'b1', title: 'L', column: 'todo', status: 'pending', depth: 0, blocking: false,
    createdAt: 'now', updatedAt: 'now', ...over,
  });

  it('starts one run for a tree adopted from a plan, and reports it running', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    await harness.db.saveBranch(branch as never);
    await harness.db.saveLeaf(leafOf({ runner: 'engine' }) as never);

    const first = await axios.post(harness.url('/api/trees/t1/run'));
    const second = await axios.post(harness.url('/api/trees/t1/run'));
    const status = await axios.get(harness.url('/api/trees/t1/run'));

    expect(first.status).toBe(202);
    expect(first.data).toMatchObject({ state: 'running' });
    expect(second.data).toMatchObject({ state: 'running' });
    expect(launcher.startGroveRun).toHaveBeenCalledWith(TEST_USER.id, 't1');
    expect(status.data).toMatchObject({ state: 'running', engine: true });
  });

  it('refuses a frozen legacy tree and says why, refuses an empty tree, never another owner\'s, and marks frozen trees in the list', async () => {
    const harness = await mount();
    await harness.db.saveTree(tree() as never);
    await harness.db.saveBranch(branch as never);
    await harness.db.saveLeaf(leafOf() as never);
    await harness.db.saveTree(tree({ id: 't2', ownerId: 'someone-else' }) as never);

    const legacy = await axios.post(harness.url('/api/trees/t1/run')).catch((e) => e);
    expect(legacy.response.status).toBe(409);
    expect(legacy.response.data.error).toMatch(/frozen/);
    expect((await axios.get(harness.url('/api/trees/t1/run'))).data).toEqual({ state: 'none', engine: false });
    expect((await axios.post(harness.url('/api/trees/t2/run')).catch((e) => e)).response.status).toBe(404);
    await harness.db.saveTree(tree({ id: 't3' }) as never);
    const empty = await axios.post(harness.url('/api/trees/t3/run')).catch((e) => e);
    expect(empty.response.status).toBe(409);
    expect(empty.response.data.error).toMatch(/Nothing is planned/);
    const listed = (await axios.get(harness.url('/api/trees'))).data as { id: string; frozen: boolean }[];
    expect(Object.fromEntries(listed.map((entry) => [entry.id, entry.frozen]))).toEqual({ t1: true, t3: false });
    expect(launcher.startGroveRun).not.toHaveBeenCalled();
  });
});

