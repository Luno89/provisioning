import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { leavesRouter } from './leaves.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { LEAF_COLUMNS } from '../lib/leaves.js';

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
    const harness = await mount();
    const err = await axios.post(harness.url('/api/leaves'), { branchId: 'b1' }).catch((e) => e);
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toMatch(/title/i);
  });

  it('rejects a column that is not one of the real ones', async () => {
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
    const harness = await mount();
    await harness.db.saveLeaf(leaf({ id: 'theirs', ownerId: 'someone-else' }) as never);
    const err = await axios.post(harness.url('/api/leaves'), {
      title: 'x', parentLeafId: 'theirs',
    }).catch((e) => e);
    expect(err.response.status).toBe(404);
  });

  /**
   * Used to write `personaId` straight onto the leaf, a field Leaf never declares — the real
   * `packId` stayed unset regardless of what was sent, so the leaf came out unassigned every time.
   * `packId` is the only field accepted now — no legacy `personaId` acceptance, since nothing
   * writes it anymore (frontend included). Same rule as PATCH /:id.
   */
  describe('assigning a pack', () => {
    const pack = (over: Record<string, unknown> = {}) => ({
      id: 'pack-1', slug: 'builder', name: 'Builder', personaId: 'persona-1',
      personaName: 'Builder', tools: [], canRunLeaf: true,
      sampling: { toolTurn: {}, conversation: {} }, budget: {} as never,
      prompt: { sections: {} }, createdAt: '', updatedAt: '',
      ...over,
    });

    it('resolves packId directly', async () => {
      const harness = await mount();
      await harness.db.savePersonaPack(pack() as never);
      const res = await axios.post(harness.url('/api/leaves'), { title: 'x', packId: 'pack-1' });
      expect(res.data.packId).toBe('pack-1');
    });

    it('resolves a slug the same way', async () => {
      const harness = await mount();
      await harness.db.savePersonaPack(pack() as never);
      const res = await axios.post(harness.url('/api/leaves'), { title: 'x', packId: 'builder' });
      expect(res.data.packId).toBe('pack-1');
    });

    it('ignores personaId — packId is the only field this accepts', async () => {
      const harness = await mount();
      await harness.db.savePersonaPack(pack() as never);
      const res = await axios.post(harness.url('/api/leaves'), { title: 'x', personaId: 'persona-1' });
      expect(res.data.packId).toBeUndefined();
    });

    it('400s a packId that matches nothing, rather than creating it unassigned', async () => {
      const harness = await mount();
      const err = await axios.post(harness.url('/api/leaves'), { title: 'x', packId: 'nope' }).catch((e) => e);
      expect(err.response.status).toBe(400);
      expect(err.response.data.error).toMatch(/no pack with that id/i);
    });

    it('400s a pack with no sandbox, since it cannot carry out work', async () => {
      const harness = await mount();
      await harness.db.savePersonaPack(pack({ canRunLeaf: false }) as never);
      const err = await axios.post(harness.url('/api/leaves'), { title: 'x', packId: 'pack-1' }).catch((e) => e);
      expect(err.response.status).toBe(400);
      expect(err.response.data.error).toMatch(/no sandbox/i);
    });
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
