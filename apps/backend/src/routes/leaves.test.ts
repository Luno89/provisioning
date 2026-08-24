import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { leavesRouter } from './leaves.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { LEAF_COLUMNS } from '../lib/leaves.js';

/**
 * The board, over real HTTP.
 *
 * Ten routes and 455 lines that had no HTTP coverage. The database is real (`MemoryDB` via the
 * harness) so these exercise the actual ownership predicate and the actual records, not a mock's
 * idea of them.
 */

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

const bridge = () => ({
  startLeaf: vi.fn(async () => ({ id: 'w1' })),
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

describe('creating a leaf', () => {
  it('requires a title, and says which field', async () => {
    // A 400 that says only "invalid" leaves the caller guessing — and the caller here is a model.
    const harness = await mount();
    const err = await axios.post(harness.url('/api/leaves'), { branchId: 'b1' }).catch((e) => e);
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toMatch(/title/i);
  });

  it('rejects a column that is not one of the real ones', async () => {
    /**
     * `column` arrives as untrusted JSON and the union type validates nothing at runtime. A leaf
     * stored in a column the board does not render is invisible work.
     */
    const harness = await mount();
    const err = await axios.post(harness.url('/api/leaves'), {
      title: 'x', branchId: 'b1', column: 'not-a-column',
    }).catch((e) => e);
    expect(err.response.status).toBe(400);
    for (const col of LEAF_COLUMNS) {
      expect(err.response.data.error).toContain(col);
    }
  });

  it('owns the new leaf to the session user, whatever the body claims', async () => {
    const harness = await mount();
    const res = await axios.post(harness.url('/api/leaves'), {
      title: 'x', branchId: 'b1', ownerId: 'someone-else',
    }, { validateStatus: () => true });
    expect(res.status, JSON.stringify(res.data)).toBeLessThan(300);
    expect(res.data.ownerId).toBe(TEST_USER.id);
  });

  it('404s a parent belonging to someone else, rather than 403', async () => {
    // Same rule as everywhere: a 403 would confirm the id exists.
    const harness = await mount();
    await harness.db.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else' }) as never);
    const err = await axios.post(harness.url('/api/leaves'), {
      title: 'x', parentLeafId: 'theirs',
    }).catch((e) => e);
    expect(err.response.status).toBe(404);
  });
});

describe('acting on one leaf', () => {
  it('404s another tenant\'s leaf on every route that takes an id', async () => {
    /**
     * Iterates rather than naming one, so a route added tomorrow that forgets the ownership filter
     * fails here. That filter was seven hand-written closures before `ownedBy`.
     */
    const harness = await mount();
    await harness.db.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else' }) as never);
    const calls: [string, () => Promise<unknown>][] = [
      ['accept', () => axios.post(harness.url('/api/leaves/theirs/accept'), {})],
      ['review', () => axios.post(harness.url('/api/leaves/theirs/review'), {})],
      ['retry', () => axios.post(harness.url('/api/leaves/theirs/retry'), {})],
      ['recheck', () => axios.post(harness.url('/api/leaves/theirs/recheck'), {})],
      ['cancel', () => axios.post(harness.url('/api/leaves/theirs/cancel'), {})],
      ['trace', () => axios.get(harness.url('/api/leaves/theirs/trace'))],
      ['patch', () => axios.patch(harness.url('/api/leaves/theirs'), { title: 'hijacked' })],
      ['delete', () => axios.delete(harness.url('/api/leaves/theirs'))],
    ];
    for (const [name, call] of calls) {
      const err = await call().catch((e: { response?: { status?: number } }) => e);
      expect((err as { response?: { status?: number } }).response?.status, name).toBe(404);
    }
    // And nothing was written.
    const stored = (await harness.db.getLeaves()).find((l) => l.id === 'theirs');
    expect(stored?.title).toBe('do a thing');
  });

  it('answers rather than hanging when a dependency throws', async () => {
    /**
     * Every handler here is wrapped. Before that, the leaves router's own tests found the cost of
     * not wrapping: a missing import made `POST /api/trees` reject, and with no `asyncRoute` the
     * request hung for 15 seconds and reported nothing.
     */
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
