import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchMemories = vi.fn();
vi.mock('./memory-index.js', () => ({ searchMemories: (...a: unknown[]) => searchMemories(...a) }));

const { recallMemories, recallQuery, orderByRelevance, markUsed, PINNED_TITLES } =
  await import('./memory-recall.js');
const { buildMemoryContext } = await import('./memory-store.js');

type Mem = import('./memory-store.js').MemoryItem;

const mem = (over: Partial<Mem> = {}): Mem => ({
  id: 'm1', ownerId: 'u1', category: 'lessons_learned',
  title: 'A lesson', text: 'Something learned.',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const bank: Mem[] = [
  mem({ id: 'newest', title: 'NEWEST', createdAt: '2026-08-20T00:00:00.000Z' }),
  mem({ id: 'relevant', title: 'RELEVANT', createdAt: '2026-01-01T00:00:00.000Z' }),
  mem({ id: 'oldest', title: 'OLDEST', createdAt: '2020-01-01T00:00:00.000Z' }),
];

beforeEach(() => { searchMemories.mockReset(); });

describe('when search answers', () => {
  it('puts what it ranked first, ahead of what is merely recent', () => {
    const ordered = orderByRelevance(bank, ['relevant', 'oldest']);
    expect(ordered.map((m) => m.id)).toEqual(['relevant', 'oldest', 'newest']);
  });

  it('still includes everything search did not rank', () => {
    const ordered = orderByRelevance(bank, ['oldest']);
    expect(new Set(ordered.map((m) => m.id))).toEqual(new Set(['oldest', 'newest', 'relevant']));
  });

  it('reports that it used hybrid search', async () => {
    searchMemories.mockResolvedValue([{ id: 'relevant', score: 1, via: ['dense'] }]);
    const out = await recallMemories({
      memories: bank, ownerId: 'u1', query: 'rate limiting', endpoints: async () => ({ index: { base: 'http://x' } }),
    });

    expect(out.via).toBe('hybrid');
    expect(out.context.indexOf('RELEVANT')).toBeLessThan(out.context.indexOf('NEWEST'));
  });
});

describe('the pinned layout fact', () => {
  it('leads, even when search ranked something else and never mentioned it', () => {
    const layout = mem({ id: 'layout', title: PINNED_TITLES[0]!, createdAt: '2020-01-01T00:00:00.000Z' });
    const ordered = orderByRelevance([...bank, layout], ['relevant']);

    expect(ordered[0]!.id).toBe('layout');
    expect(ordered[1]!.id).toBe('relevant');
  });
});

describe('when search does not answer', () => {
  const recencyOrder = buildMemoryContext(bank);

  it('falls back to recency when no endpoints exist at all', async () => {
    const out = await recallMemories({ memories: bank, ownerId: 'u1', query: 'anything' });

    expect(out.via).toBe('recency');
    expect(out.context).toBe(recencyOrder);
    expect(searchMemories).not.toHaveBeenCalled();
  });

  it('falls back when the search throws', async () => {
    searchMemories.mockImplementation(() => { throw new Error('Qdrant refused: HTTP 503'); });
    const out = await recallMemories({
      memories: bank, ownerId: 'u1', query: 'x', endpoints: async () => ({ index: { base: 'http://x' } }),
    });

    expect(out.via).toBe('recency');
    expect(out.context).toBe(recencyOrder);
  });

  it('falls back when resolving the endpoints throws', async () => {
    const out = await recallMemories({
      memories: bank, ownerId: 'u1', query: 'x',
      endpoints: async () => { throw new Error('no kubeconfig'); },
    });

    expect(out.via).toBe('recency');
    expect(out.context).toBe(recencyOrder);
  });

  it('gives up on a wedged service rather than holding the leaf open', async () => {
    searchMemories.mockImplementation(() => new Promise((r) => setTimeout(() => r([]), 400)));
    const began = Date.now();
    const out = await recallMemories({
      memories: bank, ownerId: 'u1', query: 'x',
      endpoints: async () => ({ index: { base: 'http://x' } }),
      timeoutMs: 50,
    });

    expect(Date.now() - began).toBeLessThan(1_000);
    expect(out.via).toBe('recency');
    expect(out.context).toBe(recencyOrder);
  });

  it('says recency when the stack is deployed but ranked nothing', async () => {
    searchMemories.mockResolvedValue([]);
    const out = await recallMemories({
      memories: bank, ownerId: 'u1', query: 'x', endpoints: async () => ({ index: { base: 'http://x' } }),
    });

    expect(out.via).toBe('recency');
  });
});

describe('the query', () => {
  it('is what the leaf was asked to do, not just its title', () => {
    const q = recallQuery({ title: 'Add rate limiting', body: 'to the upload route', expects: ['src/limit.ts'] });
    expect(q).toContain('Add rate limiting');
    expect(q).toContain('upload route');
    expect(q).toContain('src/limit.ts');
  });

  it('survives a leaf with nothing but a title', () => {
    expect(recallQuery({ title: 'x' })).toBe('x');
    expect(recallQuery({})).toBe('');
  });
});

describe('use bookkeeping', () => {
  it('counts what reached the prompt', async () => {
    const saved: Mem[] = [];
    await markUsed({ saveMemory: async (m: Mem) => { saved.push(m); } }, [mem({ useCount: 2 })], 'NOW');

    expect(saved[0]!.useCount).toBe(3);
    expect(saved[0]!.lastUsedAt).toBe('NOW');
  });

  it('does not let a failed write cost the leaf its run', async () => {
    await expect(markUsed({ saveMemory: async () => { throw new Error('mongo down'); } }, [mem()]))
      .resolves.toBeUndefined();
  });
});
