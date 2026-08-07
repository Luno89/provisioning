import { describe, it, expect } from 'vitest';
import {
  dependenciesMet,
  blockedBy,
  readyToStart,
  wouldCycle,
  isLeafColumn,
  LEAF_COLUMNS,
  aggregateUsage,
  failureContext,
  shouldRetry,
  MAX_LEAF_ATTEMPTS,
  type LeafAttempt,
  canAddChild,
  budgetExceeded,
  deriveLeafStatus,
  childWorkflowId,
  childrenOf,
  rootLeaf,
  subtreeOf,
  MAX_DEPTH,
  MAX_CHILDREN_PER_LEAF,
  type Leaf,
  type BudgetUsage,
} from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'c1',
  ownerId: 'u1',
  branchId: 'req-1',
  title: 'Task',
  column: 'todo',
  status: 'pending',
  depth: 0,
  blocking: true,
  createdAt: '2026-08-02T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  ...over,
});

const noUsage: BudgetUsage = { tokens: 0, wallClockMs: 0, workspaces: 0, replans: 0 };

describe('deriveLeafStatus', () => {
  it('returns the leaf\'s own status when it has no children', () => {
    expect(deriveLeafStatus('running', [])).toBe('running');
    expect(deriveLeafStatus('succeeded', [])).toBe('succeeded');
  });

  it('fails when any blocking child failed', () => {
    expect(deriveLeafStatus('running', [
      { status: 'succeeded', blocking: true },
      { status: 'failed', blocking: true },
    ])).toBe('failed');
  });

  it('IGNORES non-blocking children entirely', () => {
    // Follow-up work outlives its parent. Letting it drag the parent back to running would mean a
    // leaf could never finish — the parent would wait on work it explicitly did not wait for.
    expect(deriveLeafStatus('succeeded', [
      { status: 'running', blocking: false },
      { status: 'failed', blocking: false },
    ])).toBe('succeeded');
  });

  it('is running while any blocking child is still going', () => {
    expect(deriveLeafStatus('succeeded', [
      { status: 'succeeded', blocking: true },
      { status: 'running', blocking: true },
    ])).toBe('running');
    expect(deriveLeafStatus('succeeded', [{ status: 'pending', blocking: true }])).toBe('running');
  });

  it('does not report success until the leaf\'s OWN work is done too', () => {
    // A leaf whose children raced ahead has not integrated their output yet.
    expect(deriveLeafStatus('running', [{ status: 'succeeded', blocking: true }])).toBe('running');
    expect(deriveLeafStatus('succeeded', [{ status: 'succeeded', blocking: true }])).toBe('succeeded');
  });

  it('lets the leaf\'s own failure win over successful children', () => {
    expect(deriveLeafStatus('failed', [{ status: 'succeeded', blocking: true }])).toBe('failed');
    expect(deriveLeafStatus('cancelled', [{ status: 'succeeded', blocking: true }])).toBe('cancelled');
  });
});

describe('canAddChild', () => {
  it('allows a child within the caps', () => {
    expect(canAddChild(leaf({ depth: 0 }), 0)).toBeUndefined();
    expect(canAddChild(leaf({ depth: MAX_DEPTH - 1 }), MAX_CHILDREN_PER_LEAF - 1)).toBeUndefined();
  });

  it('refuses beyond the depth cap', () => {
    // Guards runaway decomposition: an agent that can create subtasks can create subtasks that
    // create subtasks.
    expect(canAddChild(leaf({ depth: MAX_DEPTH }), 0)).toMatch(/depth/i);
  });

  it('refuses beyond the fan-out cap', () => {
    expect(canAddChild(leaf({ depth: 0 }), MAX_CHILDREN_PER_LEAF)).toMatch(/at most/i);
  });

  it('returns a REASON rather than a boolean, so the refusal can be shown and fed back', () => {
    const reason = canAddChild(leaf({ depth: MAX_DEPTH }), 0);
    expect(typeof reason).toBe('string');
    expect(reason!.length).toBeGreaterThan(20);
  });
});

describe('budgetExceeded', () => {
  it('permits everything when no budget is set', () => {
    expect(budgetExceeded(undefined, { ...noUsage, tokens: 1e9 })).toBeUndefined();
  });

  it('stops on tokens, time, workspaces and replans independently', () => {
    expect(budgetExceeded({ maxTokens: 100 }, { ...noUsage, tokens: 100 })).toMatch(/Token/);
    expect(budgetExceeded({ maxWallClockMs: 1000 }, { ...noUsage, wallClockMs: 1000 })).toMatch(/Time/);
    expect(budgetExceeded({ maxWorkspaces: 2 }, { ...noUsage, workspaces: 2 })).toMatch(/Workspace/);
    expect(budgetExceeded({ maxReplans: 3 }, { ...noUsage, replans: 3 })).toMatch(/Replan/);
  });

  it('counts replans, because a planner that responds to failure by planning more is a loop', () => {
    expect(budgetExceeded({ maxReplans: 3 }, { ...noUsage, replans: 4 })).toMatch(/not converging/);
  });

  it('scales the time unit to the magnitude, so a short budget does not read as "0 minutes"', () => {
    expect(budgetExceeded({ maxWallClockMs: 1 }, { ...noUsage, wallClockMs: 500 })).toMatch(/0\.5 seconds/);
    expect(budgetExceeded({ maxWallClockMs: 1 }, { ...noUsage, wallClockMs: 600_000 })).toMatch(/10 minutes/);
  });

  it('allows usage strictly below the cap', () => {
    expect(budgetExceeded({ maxTokens: 100 }, { ...noUsage, tokens: 99 })).toBeUndefined();
  });
});

describe('childWorkflowId', () => {
  it('is deterministic for the same parent and index', () => {
    // The single easiest thing to get wrong: activities retry, so a partially-succeeded
    // "create subtask" with random ids yields duplicate leaves AND duplicate workspace pods.
    expect(childWorkflowId('abc', 0)).toBe(childWorkflowId('abc', 0));
  });

  it('distinguishes siblings and parents', () => {
    expect(childWorkflowId('abc', 0)).not.toBe(childWorkflowId('abc', 1));
    expect(childWorkflowId('abc', 0)).not.toBe(childWorkflowId('xyz', 0));
  });

  it('does not collide when a planner emits two identically-titled subtasks', () => {
    // Why this is index-based rather than a content hash — "write tests" twice is common.
    expect(childWorkflowId('abc', 0)).not.toBe(childWorkflowId('abc', 1));
  });
});

describe('hierarchy helpers', () => {
  const leaves: Leaf[] = [
    leaf({ id: 'root', depth: 0 }),
    leaf({ id: 'a', parentLeafId: 'root', depth: 1, createdAt: '2026-08-02T00:00:01Z' }),
    leaf({ id: 'b', parentLeafId: 'root', depth: 1, createdAt: '2026-08-02T00:00:02Z' }),
    leaf({ id: 'a1', parentLeafId: 'a', depth: 2, createdAt: '2026-08-02T00:00:03Z' }),
    leaf({ id: 'other', depth: 0 }),
  ];

  it('lists children in stable creation order', () => {
    expect(childrenOf(leaves, 'root').map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('walks to the root, which is where the budget lives', () => {
    expect(rootLeaf(leaves, leaves.find((c) => c.id === 'a1')!)?.id).toBe('root');
    expect(rootLeaf(leaves, leaves.find((c) => c.id === 'root')!)?.id).toBe('root');
  });

  it('returns undefined for a broken parent chain rather than looping', () => {
    const orphan = leaf({ id: 'orphan', parentLeafId: 'does-not-exist', depth: 1 });
    expect(rootLeaf([...leaves, orphan], orphan)).toBeUndefined();
  });

  it('collects the whole subtree for budget aggregation', () => {
    expect(subtreeOf(leaves, 'root').map((c) => c.id).sort()).toEqual(['a', 'a1', 'b']);
  });

  it('does not spin forever on a cycle', () => {
    // A cycle should be impossible, but "impossible" state reaching a while-loop is how a backend
    // hangs rather than errors.
    const cyclic: Leaf[] = [
      leaf({ id: 'x', parentLeafId: 'y', depth: 1 }),
      leaf({ id: 'y', parentLeafId: 'x', depth: 1 }),
    ];
    expect(() => subtreeOf(cyclic, 'x')).not.toThrow();
    expect(rootLeaf(cyclic, cyclic[0]!)).toBeUndefined();
  });
});

describe('aggregateUsage', () => {
  const t0 = Date.parse('2026-08-02T00:00:00Z');
  const root = leaf({ id: 'r', status: 'running', createdAt: '2026-08-02T00:00:00Z', usage: { tokens: 100 } });
  const kids: Leaf[] = [
    root,
    leaf({ id: 'a', parentLeafId: 'r', depth: 1, usage: { tokens: 50, workspaces: 1 } }),
    leaf({ id: 'b', parentLeafId: 'r', depth: 1, usage: { tokens: 25, workspaces: 1, replans: 2 } }),
    leaf({ id: 'a1', parentLeafId: 'a', depth: 2, usage: { tokens: 5 } }),
  ];

  it('sums consumables across the whole subtree, including the root', () => {
    const u = aggregateUsage(kids, root, t0 + 60_000);
    expect(u.tokens).toBe(180);
    expect(u.workspaces).toBe(2);
    expect(u.replans).toBe(2);
  });

  it('measures wall-clock from the ROOT rather than summing children', () => {
    // Children run concurrently. Summing their durations would count the same minutes several
    // times over and exhaust a time budget that had barely started.
    expect(aggregateUsage(kids, root, t0 + 60_000).wallClockMs).toBe(60_000);
  });

  it('stops the clock once the root finishes', () => {
    const done = leaf({ id: 'r', status: 'succeeded', createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-02T00:05:00Z' });
    // Long after the fact, the elapsed figure must not keep growing.
    expect(aggregateUsage([done], done, t0 + 99_999_999).wallClockMs).toBe(300_000);
  });

  it('treats missing usage as nothing recorded rather than throwing', () => {
    const bare = leaf({ id: 'r', status: 'running' });
    const u = aggregateUsage([bare], bare, t0);
    expect(u).toMatchObject({ tokens: 0, workspaces: 0, replans: 0 });
  });

  it('feeds budgetExceeded — the two halves actually connect', () => {
    const u = aggregateUsage(kids, root, t0 + 60_000);
    expect(budgetExceeded({ maxTokens: 150 }, u)).toMatch(/Token/);
    expect(budgetExceeded({ maxTokens: 500 }, u)).toBeUndefined();
    expect(budgetExceeded({ maxWallClockMs: 30_000 }, u)).toMatch(/Time/);
  });

  it('survives an unparseable timestamp instead of producing NaN', () => {
    // NaN would compare false against every budget and silently disable the time ceiling.
    const bad = leaf({ id: 'r', status: 'running', createdAt: 'not-a-date' });
    expect(aggregateUsage([bad], bad, t0).wallClockMs).toBe(0);
  });
});

describe('retry context', () => {
  const fail = (attempt: number, error: string): LeafAttempt =>
    ({ attempt, error, failedAt: '2026-08-02T00:00:00Z' });

  it('is empty for a first attempt, so callers can append unconditionally', () => {
    expect(failureContext(undefined)).toBe('');
    expect(failureContext([])).toBe('');
  });

  it('names every prior failure, not just the last', () => {
    // A leaf that failed three different ways is a different situation from one that failed the
    // same way three times, and only the full history tells them apart.
    const ctx = failureContext([fail(0, 'tests did not compile'), fail(1, 'lint failed')]);
    expect(ctx).toMatch(/tests did not compile/);
    expect(ctx).toMatch(/lint failed/);
    expect(ctx).toMatch(/attempted 2 time/);
  });

  it('numbers attempts from 1 for humans, though they are stored 0-based', () => {
    expect(failureContext([fail(0, 'boom')])).toMatch(/Attempt 1 failed/);
  });

  it('instructs the next attempt not to repeat the approach', () => {
    // Without this the model tends to retry verbatim, which is exactly what Temporal's built-in
    // retry would have done for free — and why this mechanism exists instead.
    expect(failureContext([fail(0, 'boom')])).toMatch(/Do not repeat the same approach/);
  });

  it('permits retries up to the cap and no further', () => {
    expect(shouldRetry(0)).toBe(true);
    expect(shouldRetry(MAX_LEAF_ATTEMPTS - 1)).toBe(true);
    expect(shouldRetry(MAX_LEAF_ATTEMPTS)).toBe(false);
    expect(shouldRetry(MAX_LEAF_ATTEMPTS + 1)).toBe(false);
  });
});

describe('isLeafColumn', () => {
  it('accepts the real columns', () => {
    for (const c of LEAF_COLUMNS) expect(isLeafColumn(c)).toBe(true);
  });

  it('rejects columns that were removed', () => {
    // A 'done' column was accepted with a 201 and written to the database before this guard
    // existed, leaving a leaf in a state the UI could neither render nor move it out of. The
    // union type validates nothing at a request boundary.
    expect(isLeafColumn('done')).toBe(false);
    expect(isLeafColumn('backlog')).toBe(false);
  });

  it('rejects non-strings without throwing', () => {
    for (const v of [undefined, null, 42, {}, []]) expect(isLeafColumn(v)).toBe(false);
  });
});

describe('dependency ordering', () => {
  const leaf = (over: Partial<Leaf>): Leaf => ({
    id: 'l1', ownerId: 'u1', branchId: 'b1', title: 't', column: 'todo',
    status: 'pending', depth: 0, blocking: true,
    createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
    ...over,
  });

  it('holds a leaf until every dependency has SUCCEEDED', () => {
    // The measured failure: five siblings fanned out, and the four that needed the first one's
    // output each woke in an empty sandbox and spent all 24 steps rebuilding it.
    const base = leaf({ id: 'base', status: 'running' });
    const next = leaf({ id: 'next', dependsOn: ['base'] });

    expect(dependenciesMet(next, [base, next])).toBe(false);
    expect(readyToStart([base, next])).toEqual([]);
    expect(blockedBy(next, [base, next]).map((l) => l.id)).toEqual(['base']);
  });

  it('releases it once they have', () => {
    const base = leaf({ id: 'base', status: 'succeeded' });
    const next = leaf({ id: 'next', dependsOn: ['base'] });

    expect(readyToStart([base, next]).map((l) => l.id)).toEqual(['next']);
  });

  it('keeps holding a leaf whose dependency FAILED, since a retry can still satisfy it', () => {
    // Distinct from a deleted dependency below: the work is still expected, it just has not
    // happened. Releasing here would run the dependent against output that does not exist.
    const base = leaf({ id: 'base', status: 'failed' });
    const next = leaf({ id: 'next', dependsOn: ['base'] });

    expect(dependenciesMet(next, [base, next])).toBe(false);
  });

  it('treats a deleted dependency as met rather than stranding the leaf forever', () => {
    // There is no future in which a leaf that no longer exists succeeds, so waiting on it is
    // waiting for nothing — and nothing in the UI can clear it.
    const next = leaf({ id: 'next', dependsOn: ['deleted'] });

    expect(dependenciesMet(next, [next])).toBe(true);
  });

  it('never starts a leaf that already has a workflow', () => {
    // Starting twice is the expensive mistake: two sandboxes, two sets of tokens, one leaf.
    const started = leaf({ id: 'started', workflowId: 'leaf-started' });

    expect(readyToStart([started])).toEqual([]);
  });

  it('refuses a dependency that would close a cycle', () => {
    // A cycle does not fail — every leaf in it waits forever, which looks exactly like slow work.
    const a = leaf({ id: 'a', dependsOn: ['b'] });
    const b = leaf({ id: 'b', dependsOn: ['c'] });
    const c = leaf({ id: 'c' });

    expect(wouldCycle('c', ['a'], [a, b, c])).toBe(true);
    expect(wouldCycle('c', [], [a, b, c])).toBe(false);
    // Self-reference is the degenerate case and the easiest one to write by accident.
    expect(wouldCycle('c', ['c'], [a, b, c])).toBe(true);
  });

  it('releases a whole chain one step at a time, not all at once', () => {
    // The shape the plan actually had: build → search → query builder, strictly in order.
    const one = leaf({ id: 'one', status: 'succeeded' });
    const two = leaf({ id: 'two', dependsOn: ['one'] });
    const three = leaf({ id: 'three', dependsOn: ['two'] });

    expect(readyToStart([one, two, three]).map((l) => l.id)).toEqual(['two']);
    const done = { ...two, status: 'succeeded' as const };
    expect(readyToStart([one, done, three]).map((l) => l.id)).toEqual(['three']);
  });
});
