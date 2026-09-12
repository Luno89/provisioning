import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { treesRouter } from './trees.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const mount = async (): Promise<Harness> => {
  h = await mountRouter({
    prefix: '/api/trees',
    router: (db) => treesRouter({ db, temporalBridge: {} as never }),
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
