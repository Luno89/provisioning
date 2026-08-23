import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ── THE PROPERTY THIS FILE EXISTS TO PROTECT ──
 *
 * Hybrid recall is allowed to make memory BETTER. It is never allowed to make a leaf worse off than
 * it was before any of this existed. Qdrant down, Quickwit down, TEI down, nothing deployed, a
 * service reachable but wedged — every one of those must land a leaf on exactly the scope-and-
 * recency block it used to get, inside the cap, with no error.
 *
 * That is what makes it safe for the vector stack to be a disposable index over Mongo rather than a
 * dependency. If these tests do not hold, that claim is decoration.
 */

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

/** A bank where recency and relevance disagree, so the two orderings are distinguishable. */
const bank: Mem[] = [
  mem({ id: 'newest', title: 'NEWEST', createdAt: '2026-08-20T00:00:00.000Z' }),
  mem({ id: 'relevant', title: 'RELEVANT', createdAt: '2026-01-01T00:00:00.000Z' }),
  mem({ id: 'oldest', title: 'OLDEST', createdAt: '2020-01-01T00:00:00.000Z' }),
];

// Block body, not an expression body. `mockReset()` returns the mock, and vitest treats a function
// returned from a hook as a TEARDOWN callback — so the concise form has vitest calling the mock
// after each test, and any implementation that throws then fails the test it just passed.
beforeEach(() => { searchMemories.mockReset(); });

describe('when search answers', () => {
  it('puts what it ranked first, ahead of what is merely recent', () => {
    const ordered = orderByRelevance(bank, ['relevant', 'oldest']);
    expect(ordered.map((m) => m.id)).toEqual(['relevant', 'oldest', 'newest']);
  });

  it('still includes everything search did not rank', () => {
    // The tail matters as much as the head: a leaf must never receive LESS than before.
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
  /**
   * Hybrid search is worst at exactly the memory that matters most. A file listing shares no
   * vocabulary with "add rate limiting to the upload route", so it ranks nowhere on either half —
   * and it is the entry that stops a leaf spending its budget on `ls -la` while three finished
   * leaves have already built the thing it is standing in.
   */
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
    /**
     * Throws synchronously rather than returning a rejected promise.
     *
     * vitest records every mock's return value in `mock.results`, which means a returned promise
     * gets a handler attached by the harness as well as by the code under test — and a rejected one
     * then surfaces as an unhandled rejection no matter how correctly `recallMemories` catches it.
     * Verified outside vitest: the rejection is absorbed and `via` is `recency`. A synchronous
     * throw inside the async caller becomes the same rejection without the harness artifact.
     */
    searchMemories.mockImplementation(() => { throw new Error('Qdrant refused: HTTP 503'); });
    const out = await recallMemories({
      memories: bank, ownerId: 'u1', query: 'x', endpoints: async () => ({ index: { base: 'http://x' } }),
    });

    expect(out.via).toBe('recency');
    expect(out.context).toBe(recencyOrder);
  });

  it('falls back when resolving the endpoints throws', async () => {
    // `corpusEndpoints` port-forwards into a cluster. A cluster that has gone away must not be an
    // exception thrown at the top of a leaf.
    const out = await recallMemories({
      memories: bank, ownerId: 'u1', query: 'x',
      endpoints: async () => { throw new Error('no kubeconfig'); },
    });

    expect(out.via).toBe('recency');
    expect(out.context).toBe(recencyOrder);
  });

  it('gives up on a wedged service rather than holding the leaf open', async () => {
    // Reachable but slow is the failure a try/catch does not cover. Slower than the cap rather
    // than never-settling: a promise that never settles is one vitest waits on at teardown, which
    // hangs the file rather than testing it.
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
