import { describe, it, expect } from 'vitest';
import {
  aggregateUsage,
  failureContext,
  shouldRetry,
  MAX_CARD_ATTEMPTS,
  type CardAttempt,
  canAddChild,
  budgetExceeded,
  deriveCardStatus,
  childWorkflowId,
  childrenOf,
  rootCard,
  subtreeOf,
  MAX_DEPTH,
  MAX_CHILDREN_PER_CARD,
  type Card,
  type BudgetUsage,
} from './board.js';

const card = (over: Partial<Card> = {}): Card => ({
  id: 'c1',
  ownerId: 'u1',
  requestId: 'req-1',
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

describe('deriveCardStatus', () => {
  it('returns the card\'s own status when it has no children', () => {
    expect(deriveCardStatus('running', [])).toBe('running');
    expect(deriveCardStatus('succeeded', [])).toBe('succeeded');
  });

  it('fails when any blocking child failed', () => {
    expect(deriveCardStatus('running', [
      { status: 'succeeded', blocking: true },
      { status: 'failed', blocking: true },
    ])).toBe('failed');
  });

  it('IGNORES non-blocking children entirely', () => {
    // Follow-up work outlives its parent. Letting it drag the parent back to running would mean a
    // card could never finish — the parent would wait on work it explicitly did not wait for.
    expect(deriveCardStatus('succeeded', [
      { status: 'running', blocking: false },
      { status: 'failed', blocking: false },
    ])).toBe('succeeded');
  });

  it('is running while any blocking child is still going', () => {
    expect(deriveCardStatus('succeeded', [
      { status: 'succeeded', blocking: true },
      { status: 'running', blocking: true },
    ])).toBe('running');
    expect(deriveCardStatus('succeeded', [{ status: 'pending', blocking: true }])).toBe('running');
  });

  it('does not report success until the card\'s OWN work is done too', () => {
    // A card whose children raced ahead has not integrated their output yet.
    expect(deriveCardStatus('running', [{ status: 'succeeded', blocking: true }])).toBe('running');
    expect(deriveCardStatus('succeeded', [{ status: 'succeeded', blocking: true }])).toBe('succeeded');
  });

  it('lets the card\'s own failure win over successful children', () => {
    expect(deriveCardStatus('failed', [{ status: 'succeeded', blocking: true }])).toBe('failed');
    expect(deriveCardStatus('cancelled', [{ status: 'succeeded', blocking: true }])).toBe('cancelled');
  });
});

describe('canAddChild', () => {
  it('allows a child within the caps', () => {
    expect(canAddChild(card({ depth: 0 }), 0)).toBeUndefined();
    expect(canAddChild(card({ depth: MAX_DEPTH - 1 }), MAX_CHILDREN_PER_CARD - 1)).toBeUndefined();
  });

  it('refuses beyond the depth cap', () => {
    // Guards runaway decomposition: an agent that can create subtasks can create subtasks that
    // create subtasks.
    expect(canAddChild(card({ depth: MAX_DEPTH }), 0)).toMatch(/depth/i);
  });

  it('refuses beyond the fan-out cap', () => {
    expect(canAddChild(card({ depth: 0 }), MAX_CHILDREN_PER_CARD)).toMatch(/at most/i);
  });

  it('returns a REASON rather than a boolean, so the refusal can be shown and fed back', () => {
    const reason = canAddChild(card({ depth: MAX_DEPTH }), 0);
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
    // "create subtask" with random ids yields duplicate cards AND duplicate workspace pods.
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
  const cards: Card[] = [
    card({ id: 'root', depth: 0 }),
    card({ id: 'a', parentCardId: 'root', depth: 1, createdAt: '2026-08-02T00:00:01Z' }),
    card({ id: 'b', parentCardId: 'root', depth: 1, createdAt: '2026-08-02T00:00:02Z' }),
    card({ id: 'a1', parentCardId: 'a', depth: 2, createdAt: '2026-08-02T00:00:03Z' }),
    card({ id: 'other', depth: 0 }),
  ];

  it('lists children in stable creation order', () => {
    expect(childrenOf(cards, 'root').map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('walks to the root, which is where the budget lives', () => {
    expect(rootCard(cards, cards.find((c) => c.id === 'a1')!)?.id).toBe('root');
    expect(rootCard(cards, cards.find((c) => c.id === 'root')!)?.id).toBe('root');
  });

  it('returns undefined for a broken parent chain rather than looping', () => {
    const orphan = card({ id: 'orphan', parentCardId: 'does-not-exist', depth: 1 });
    expect(rootCard([...cards, orphan], orphan)).toBeUndefined();
  });

  it('collects the whole subtree for budget aggregation', () => {
    expect(subtreeOf(cards, 'root').map((c) => c.id).sort()).toEqual(['a', 'a1', 'b']);
  });

  it('does not spin forever on a cycle', () => {
    // A cycle should be impossible, but "impossible" state reaching a while-loop is how a backend
    // hangs rather than errors.
    const cyclic: Card[] = [
      card({ id: 'x', parentCardId: 'y', depth: 1 }),
      card({ id: 'y', parentCardId: 'x', depth: 1 }),
    ];
    expect(() => subtreeOf(cyclic, 'x')).not.toThrow();
    expect(rootCard(cyclic, cyclic[0]!)).toBeUndefined();
  });
});

describe('aggregateUsage', () => {
  const t0 = Date.parse('2026-08-02T00:00:00Z');
  const root = card({ id: 'r', status: 'running', createdAt: '2026-08-02T00:00:00Z', usage: { tokens: 100 } });
  const kids: Card[] = [
    root,
    card({ id: 'a', parentCardId: 'r', depth: 1, usage: { tokens: 50, workspaces: 1 } }),
    card({ id: 'b', parentCardId: 'r', depth: 1, usage: { tokens: 25, workspaces: 1, replans: 2 } }),
    card({ id: 'a1', parentCardId: 'a', depth: 2, usage: { tokens: 5 } }),
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
    const done = card({ id: 'r', status: 'succeeded', createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-02T00:05:00Z' });
    // Long after the fact, the elapsed figure must not keep growing.
    expect(aggregateUsage([done], done, t0 + 99_999_999).wallClockMs).toBe(300_000);
  });

  it('treats missing usage as nothing recorded rather than throwing', () => {
    const bare = card({ id: 'r', status: 'running' });
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
    const bad = card({ id: 'r', status: 'running', createdAt: 'not-a-date' });
    expect(aggregateUsage([bad], bad, t0).wallClockMs).toBe(0);
  });
});

describe('retry context', () => {
  const fail = (attempt: number, error: string): CardAttempt =>
    ({ attempt, error, failedAt: '2026-08-02T00:00:00Z' });

  it('is empty for a first attempt, so callers can append unconditionally', () => {
    expect(failureContext(undefined)).toBe('');
    expect(failureContext([])).toBe('');
  });

  it('names every prior failure, not just the last', () => {
    // A card that failed three different ways is a different situation from one that failed the
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
    expect(shouldRetry(MAX_CARD_ATTEMPTS - 1)).toBe(true);
    expect(shouldRetry(MAX_CARD_ATTEMPTS)).toBe(false);
    expect(shouldRetry(MAX_CARD_ATTEMPTS + 1)).toBe(false);
  });
});
