import { describe, it, expect } from 'vitest';
import {
  consolidateMemories, planTitleDedupe, planSimilarityDedupe, planPromotions,
  planUnreachable, DUPLICATE_SIMILARITY, type PromotableLeaf,
} from './memory-consolidate.js';
import type { MemoryItem } from './memory-store.js';

const NOW = '2026-08-21T12:00:00.000Z';
const daysBefore = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const mem = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'm1', ownerId: 'u1', projectId: 'p1', category: 'lessons_learned', scope: 'project',
  title: 'A lesson', text: 'Something learned.',
  createdAt: daysBefore(1), updatedAt: daysBefore(1), lastUsedAt: daysBefore(1),
  ...over,
});

describe('duplicates by title', () => {
  it('collapses the repeated failure titles this extractor generates', () => {
    const copies = [1, 2, 3, 4, 5].map((i) => mem({
      id: `dup${i}`, title: 'Promised a file it did not deliver', createdAt: daysBefore(i),
    }));

    const retired = planTitleDedupe(copies, NOW);

    expect(retired.map((m) => m.id)).toEqual(['dup2', 'dup3', 'dup4', 'dup5']);
    expect(retired.every((m) => m.mergedInto === 'dup1')).toBe(true);
    expect(retired.every((m) => m.invalidAt === NOW)).toBe(true);
  });

  it('keeps the newest as the survivor', () => {
    const retired = planTitleDedupe([
      mem({ id: 'old', createdAt: daysBefore(9) }),
      mem({ id: 'new', createdAt: daysBefore(1) }),
    ], NOW);

    expect(retired.map((m) => m.id)).toEqual(['old']);
    expect(retired[0]!.mergedInto).toBe('new');
  });

  it('does not merge across projects, owners or categories', () => {
    const items = [
      mem({ id: 'a', projectId: 'p1' }),
      mem({ id: 'b', projectId: 'p2' }),
      mem({ id: 'c', ownerId: 'u2' }),
      mem({ id: 'd', category: 'environment_facts' }),
    ];

    expect(planTitleDedupe(items, NOW)).toEqual([]);
  });

  it('ignores what is already retired', () => {
    const items = [mem({ id: 'a' }), mem({ id: 'b', invalidAt: 'EARLIER' })];
    expect(planTitleDedupe(items, NOW)).toEqual([]);
  });

  it('matches on case and spacing, which is how the same title differs', () => {
    const retired = planTitleDedupe([
      mem({ id: 'a', title: 'Repository layout', createdAt: daysBefore(1) }),
      mem({ id: 'b', title: '  repository   LAYOUT ', createdAt: daysBefore(2) }),
    ], NOW);

    expect(retired.map((m) => m.id)).toEqual(['b']);
  });
});

describe('duplicates by meaning', () => {
  const similar = (pairs: Record<string, [string, number][]>) =>
    new Map(Object.entries(pairs).map(([id, hits]) =>
      [id, hits.map(([h, score]) => ({ id: h, score }))]));

  it('retires the older of a near-identical pair', () => {
    const items = [mem({ id: 'new', title: 'X', createdAt: daysBefore(1) }), mem({ id: 'old', title: 'Y', createdAt: daysBefore(5) })];
    const retired = planSimilarityDedupe(items, similar({ new: [['old', 0.99]] }), NOW);

    expect(retired.map((m) => m.id)).toEqual(['old']);
    expect(retired[0]!.mergedInto).toBe('new');
  });

  it('leaves a merely related pair alone', () => {
    const items = [mem({ id: 'a', title: 'X' }), mem({ id: 'b', title: 'Y', createdAt: daysBefore(5) })];

    expect(planSimilarityDedupe(items, similar({ a: [['b', DUPLICATE_SIMILARITY - 0.01]] }), NOW)).toEqual([]);
  });

  it('does not merge a high-similarity pair from different projects', () => {
    const items = [mem({ id: 'a', title: 'X', projectId: 'p1' }), mem({ id: 'b', title: 'Y', projectId: 'p2', createdAt: daysBefore(5) })];
    expect(planSimilarityDedupe(items, similar({ a: [['b', 0.999]] }), NOW)).toEqual([]);
  });

  it('does not follow a chain through an entry it just retired', () => {
    const items = [
      mem({ id: 'newest', title: 'X', createdAt: daysBefore(1) }),
      mem({ id: 'middle', title: 'Y', createdAt: daysBefore(2) }),
      mem({ id: 'oldest', title: 'Z', createdAt: daysBefore(3) }),
    ];
    const retired = planSimilarityDedupe(items, similar({
      newest: [['middle', 0.99]], middle: [['oldest', 0.99]],
    }), NOW);

    expect(retired.map((m) => m.id)).toEqual(['middle']);
    expect(retired[0]!.mergedInto).toBe('newest');
  });

  it('does nothing when the vector half is down', () => {
    expect(planSimilarityDedupe([mem()], new Map(), NOW)).toEqual([]);
  });
});

describe('promoting what a research leaf found', () => {
  const leaf = (over: Partial<PromotableLeaf> = {}): PromotableLeaf => ({
    id: 'l1', ownerId: 'u1', projectId: 'p1', title: 'Compare vector stores',
    findings: 'x'.repeat(400), status: 'succeeded', ...over,
  });

  it('makes findings searchable, which nothing else does', () => {
    const out = planPromotions([leaf()], [], NOW, () => 'new1');

    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('What "Compare vector stores" established');
    expect(out[0]!.provenance?.taskId).toBe('l1');
    expect(out[0]!.status).toBe('active');
  });

  it('scopes to the owner when a research leaf has no project', () => {
    const out = planPromotions([leaf({ projectId: undefined })], [], NOW, () => 'x');

    expect(out).toHaveLength(1);
    expect(out[0]!.scope).toBe('global');
    expect(out[0]!.projectId).toBeUndefined();
  });

  it('prefers the tighter scope when the leaf does have a project', () => {
    const out = planPromotions([leaf({ projectId: 'p1' })], [], NOW, () => 'x');

    expect(out[0]!.scope).toBe('project');
    expect(out[0]!.projectId).toBe('p1');
  });

  it('never produces the unreachable shape', () => {
    for (const l of [leaf({ projectId: 'p1' }), leaf({ projectId: undefined })]) {
      const [m] = planPromotions([l], [], NOW, () => 'x');
      expect(m!.scope === 'project' ? Boolean(m!.projectId) : true).toBe(true);
    }
  });

  it('skips a leaf that failed, and a finding too thin to be knowledge', () => {
    expect(planPromotions([leaf({ status: 'failed' })], [], NOW, () => 'x')).toEqual([]);
    expect(planPromotions([leaf({ findings: 'Done.' })], [], NOW, () => 'x')).toEqual([]);
    expect(planPromotions([leaf({ findings: undefined })], [], NOW, () => 'x')).toEqual([]);
  });

  it('does not promote the same leaf twice', () => {
    const already = [mem({ title: 'What "Compare vector stores" established' })];
    expect(planPromotions([leaf()], already, NOW, () => 'x')).toEqual([]);
  });
});

describe('memories nothing can ever read', () => {
  it('retires a project-scoped memory that has no project', () => {
    const orphan = mem({ id: 'orphan', scope: 'project' });
    delete (orphan as { projectId?: string }).projectId;

    const out = planUnreachable([orphan], NOW);
    expect(out.map((m) => m.id)).toEqual(['orphan']);
    expect(out[0]!.invalidAt).toBe(NOW);
  });

  it('leaves global and properly scoped memories alone', () => {
    const global = mem({ id: 'g', scope: 'global' });
    delete (global as { projectId?: string }).projectId;

    expect(planUnreachable([global, mem({ id: 'ok', scope: 'project', projectId: 'p1' })], NOW)).toEqual([]);
  });
});

describe('a whole pass', () => {
  const setup = (memories: MemoryItem[], leaves: PromotableLeaf[] = []) => {
    const store = new Map(memories.map((m) => [m.id, m]));
    const unindexed: { ids: string[]; liveThen: boolean[] }[] = [];
    let n = 0;
    return {
      store,
      unindexed,
      deps: {
        unindex: async (retired: MemoryItem[]) => {
          unindexed.push({ ids: retired.map((m) => m.id), liveThen: retired.map((m) => !store.get(m.id)?.invalidAt) });
        },
        db: {
          memory: {
            getMemories: async (ownerId?: string) => [...store.values()].filter((m) => !ownerId || m.ownerId === ownerId),
            saveMemory: async (m: MemoryItem) => { store.set(m.id, m); },
          },
          projects: {
            getLeaves: async () => leaves,
          },
        },
        now: () => NOW,
        newId: () => `gen${n++}`,
      },
    };
  };

  it('converges: a second pass changes nothing', async () => {
    const { store, deps } = setup([
      mem({ id: 'a', title: 'Dup', createdAt: daysBefore(1) }),
      mem({ id: 'b', title: 'Dup', createdAt: daysBefore(2) }),
      mem({ id: 'c', title: 'Kept', createdAt: daysBefore(1) }),
    ], [{ id: 'l1', ownerId: 'u1', projectId: 'p1', title: 'Research', findings: 'y'.repeat(400), status: 'succeeded' }]);

    const first = await consolidateMemories(deps);
    const snapshot = JSON.stringify([...store.values()]);
    const second = await consolidateMemories(deps);

    expect(first.deduped).toBe(1);
    expect(first.promoted).toBe(1);
    expect(second.deduped).toBe(0);
    expect(second.promoted).toBe(0);
    expect(JSON.stringify([...store.values()])).toBe(snapshot);
  });

  it('never retires a memory for its age, however long nothing has read it', async () => {
    const { deps, store } = setup([
      mem({ id: 'old', title: 'Old and unread', createdAt: daysBefore(400), lastUsedAt: daysBefore(400) }),
      (({ lastUsedAt: _, ...rest }) => rest)(mem({ id: 'never-read', title: 'Never read', createdAt: daysBefore(400) })),
    ]);

    const report = await consolidateMemories(deps);

    expect(report).not.toHaveProperty('decayed');
    expect(report.live).toBe(2);
    expect(store.get('old')!.invalidAt).toBeUndefined();
    expect(store.get('never-read')!.invalidAt).toBeUndefined();
  });

  it('consolidates one owner at a time, leaving everyone else\'s memories untouched', async () => {
    const { deps, store } = setup([
      mem({ id: 'a', title: 'Dup', createdAt: daysBefore(1) }),
      mem({ id: 'b', title: 'Dup', createdAt: daysBefore(2) }),
      mem({ id: 'c', ownerId: 'someone-else', title: 'Dup', createdAt: daysBefore(1) }),
      mem({ id: 'd', ownerId: 'someone-else', title: 'Dup', createdAt: daysBefore(2) }),
    ]);

    const report = await consolidateMemories({ ...deps, ownerId: 'someone-else' });

    expect(report.deduped).toBe(1);
    expect(store.get('d')!.invalidAt).toBeDefined();
    expect(store.get('b')!.invalidAt).toBeUndefined();
  });

  it('does nothing to an empty bank', async () => {
    const { deps } = setup([]);
    expect(await consolidateMemories(deps)).toMatchObject({ indexed: 0, deduped: 0, promoted: 0, live: 0 });
  });

  it('consolidates even when the index is unreachable', async () => {
    const { deps } = setup([
      mem({ id: 'a', title: 'Dup', createdAt: daysBefore(1) }),
      mem({ id: 'b', title: 'Dup', createdAt: daysBefore(2) }),
    ]);

    const report = await consolidateMemories({
      ...deps,
      index: async () => { throw new Error('Qdrant down'); },
    });

    expect(report.deduped).toBe(1);
    expect(report.indexed).toBe(0);
  });

  it('takes what a pass retires out of the index before marking it retired', async () => {
    const { deps, unindexed } = setup([
      mem({ id: 'a', title: 'Dup', createdAt: daysBefore(1), lastUsedAt: daysBefore(1) }),
      mem({ id: 'b', title: 'Dup', createdAt: daysBefore(2), lastUsedAt: daysBefore(2) }),
    ]);

    await consolidateMemories(deps);

    expect(unindexed).toEqual([{ ids: ['b'], liveThen: [true] }]);
  });

  it('retires nothing when the index will not let go, and the pass fails saying why', async () => {
    const { deps, store } = setup([
      mem({ id: 'a', title: 'Dup', createdAt: daysBefore(1) }),
      mem({ id: 'b', title: 'Dup', createdAt: daysBefore(2) }),
    ]);

    await expect(consolidateMemories({ ...deps, unindex: async () => { throw new Error('Qdrant refused: HTTP 503 overloaded'); } })).rejects.toThrow('Qdrant refused: HTTP 503 overloaded');
    expect(store.get('b')!.invalidAt).toBeUndefined();
  });

  it('leaves the review backlog out of the index', async () => {
    const { deps } = setup([mem({ id: 'a', status: 'pending_review' })]);
    let sent: MemoryItem[] = [];

    await consolidateMemories({ ...deps, index: async (items) => { sent = items; return { vectors: items.length, documents: items.length }; } });
    expect(sent).toEqual([]);
  });
});
