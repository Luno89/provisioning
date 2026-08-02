import { describe, it, expect } from 'vitest';
import {
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
  boardId: 'b1',
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
