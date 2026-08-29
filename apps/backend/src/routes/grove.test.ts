import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { treeTypesRouter } from './tree-types.js';
import { treesRouter } from './trees.js';
import { branchesRouter } from './branches.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const bridge = () => ({
  startBranch: vi.fn(async () => ({ id: 'w1' })),
  cancelBranch: vi.fn(async () => undefined),
  terminateForBranch: vi.fn(async () => undefined),
}) as never;

describe('the tree-type catalogue', () => {
  it('seeds on first read, so a user who predates a type still gets it', async () => {
    h = await mountRouter({
      prefix: '/api/tree-types',
      router: (db) => treeTypesRouter({ db }),
    });
    const res = await axios.get(h.url('/api/tree-types'));
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
    const again = await axios.get(h.url('/api/tree-types'));
    expect(again.data.length).toBe(res.data.length);
  });

  it('refuses an unauthenticated caller', async () => {
    h = await mountRouter({
      prefix: '/api/tree-types',
      user: null,
      router: (db) => treeTypesRouter({ db }),
    });
    await expect(axios.get(h.url('/api/tree-types'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});

describe('trees', () => {
  const mount = async () => {
    h = await mountRouter({
      prefix: '/api/trees',
      router: (db) => treesRouter({ db, temporalBridge: bridge() }),
    });
    return h!;
  };

  it('lists only the caller\'s own', async () => {
    const harness = await mount();
    await harness.db.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'mine', projectIds: [] } as never);
    await harness.db.saveTree({ id: 't2', ownerId: 'someone-else', name: 'theirs', projectIds: [] } as never);
    const res = await axios.get(harness.url('/api/trees'));
    expect(res.data.map((t: { name: string }) => t.name)).toEqual(['mine']);
  });

  it('does not let one tenant read another\'s by guessing the id', async () => {
    const harness = await mount();
    await harness.db.saveTree({ id: 't2', ownerId: 'someone-else', name: 'theirs', projectIds: [] } as never);
    const err = await axios.get(harness.url('/api/trees/t2/board')).catch((e) => e);
    expect(err.response.status).toBe(404);
  });

  it('creates a tree owned by the session user, not by anything in the body', async () => {
    const harness = await mount();
    const res = await axios.post(harness.url('/api/trees'), {
      name: 'new', goal: 'g', type: 'research-paper', ownerId: 'someone-else',
    }, { validateStatus: () => true });
    expect(res.status, JSON.stringify(res.data)).toBeLessThan(300);
    const stored = (await harness.db.getTrees()).find((t) => t.name === 'new');
    expect(stored?.ownerId).toBe(TEST_USER.id);
  });
});

describe('branches', () => {
  const mount = async () => {
    h = await mountRouter({
      prefix: '/api/branches',
      router: (db) => branchesRouter({ db, temporalBridge: bridge() }),
    });
    return h!;
  };

  it('lists only the caller\'s own', async () => {
    const harness = await mount();
    await harness.db.saveBranch({ id: 'b1', ownerId: TEST_USER.id, title: 'mine', messages: [] } as never);
    await harness.db.saveBranch({ id: 'b2', ownerId: 'someone-else', title: 'theirs', messages: [] } as never);
    const res = await axios.get(harness.url('/api/branches'));
    expect(res.data.map((b: { title: string }) => b.title)).toEqual(['mine']);
  });

  it('404s a branch belonging to someone else rather than 403', async () => {
    const harness = await mount();
    await harness.db.saveBranch({ id: 'b2', ownerId: 'someone-else', title: 'theirs', messages: [] } as never);
    const err = await axios.patch(harness.url('/api/branches/b2'), { title: 'hijacked' }).catch((e) => e);
    expect(err.response.status).toBe(404);
    const stored = (await harness.db.getBranches()).find((b) => b.id === 'b2');
    expect(stored?.title).toBe('theirs');
  });

  it('creates a branch owned by the session user', async () => {
    const harness = await mount();
    await harness.db.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'T', projectIds: [] } as never);
    const res = await axios.post(harness.url('/api/branches'), {
      treeId: 't1', title: 'new', ownerId: 'someone-else',
    });
    expect(res.status).toBeLessThan(300);
    expect(res.data.ownerId).toBe(TEST_USER.id);
  });
});
