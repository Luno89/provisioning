import { describe, it, expect } from 'vitest';
import { columnFor, rollup, changedSince } from './tree-board.js';
import { trimTrace, droppedCount, MAX_TRACE_CHARS, KEEP_OPENING } from './leaf-trace.js';
import type { Leaf } from './leaves.js';
import type { AgentStep } from '@koala/harness-types';

const leaf = (over: Record<string, unknown> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'A leaf', status: 'succeeded',
  column: 'todo', depth: 0, blocking: false,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...over,
} as Leaf);

describe('which column a leaf belongs in', () => {
  it('never shows a claim as verified', () => {
    /**
     * The whole reason the board has two done-columns. Half of what "finished" means here is a
     * model's report on its own work, and `leaf-verify.ts` exists to keep that apart from a check
     * that actually ran.
     */
    expect(columnFor(leaf({ status: 'succeeded', verified: true }), false)).toBe('verified');
    expect(columnFor(leaf({ status: 'succeeded', verified: false }), false)).toBe('claimed');
    expect(columnFor(leaf({ status: 'succeeded' }), false)).toBe('claimed');
  });

  it('splits pending into queued and blocked', () => {
    // Identical in the data, opposite to a reader: one is next up, the other is stuck.
    expect(columnFor(leaf({ status: 'pending' }), false)).toBe('proposed');
    expect(columnFor(leaf({ status: 'pending' }), true)).toBe('blocked');
  });

  it('leaves cancelled work off the board entirely', () => {
    // Neither done nor outstanding — counting it as either misstates the total.
    expect(columnFor(leaf({ status: 'cancelled' }), false)).toBeUndefined();
  });
});

describe('the rollup', () => {
  const never = () => false;

  it('counts failures as outstanding', () => {
    /**
     * A failed leaf is work the tree still owes. Folding it into a done total is how a project
     * reports itself complete while broken.
     */
    const r = rollup([
      leaf({ id: 'a', status: 'succeeded', verified: true }),
      leaf({ id: 'b', status: 'failed' }),
    ], never);
    expect(r.counts.verified).toBe(1);
    expect(r.counts.failed).toBe(1);
    expect(r.outstanding).toBe(1);
  });

  it('never adds verified and claimed together', () => {
    const r = rollup([
      leaf({ id: 'a', status: 'succeeded', verified: true }),
      leaf({ id: 'b', status: 'succeeded' }),
    ], never);
    expect(r.counts.verified).toBe(1);
    expect(r.counts.claimed).toBe(1);
    expect(r.outstanding).toBe(0);
  });

  it('sums measured tokens and notices retries', () => {
    const r = rollup([
      leaf({ id: 'a', usage: { tokens: 1200 } }),
      leaf({ id: 'b', usage: { tokens: 800 }, attempts: [{}, {}] }),
    ], never);
    expect(r.tokens).toBe(2000);
    expect(r.retried).toBe(1);
  });

  it('counts the conversations the work came from', () => {
    const r = rollup([leaf({ id: 'a', branchId: 'b1' }), leaf({ id: 'b', branchId: 'b2' })], never);
    expect(r.branches).toBe(2);
  });

  it('is empty rather than broken for a tree with no work', () => {
    const r = rollup([], never);
    expect(r.outstanding).toBe(0);
    expect(r.branches).toBe(0);
  });
});

describe('what changed while nobody was looking', () => {
  it('counts only what moved after the given moment', () => {
    // This board changes on its own, so a static snapshot is the wrong metaphor.
    const leaves = [
      leaf({ id: 'a', updatedAt: '2026-01-01T00:00:00Z' }),
      leaf({ id: 'b', updatedAt: '2026-01-02T00:00:00Z' }),
    ];
    expect(changedSince(leaves, '2026-01-01T12:00:00Z')).toBe(1);
  });

  it('claims nothing changed when there is nothing to compare against', () => {
    // A first visit should not report every leaf as new.
    expect(changedSince([leaf()], undefined)).toBe(0);
  });
});

describe('fitting a trace into its budget', () => {
  const step = (n: number, size = 100): AgentStep => ({
    step: n, toolCalls: [], toolResults: [], tokens: 10,
    content: 'x'.repeat(size),
  });

  it('keeps a short trace whole', () => {
    const { steps, trimmed } = trimTrace([step(1), step(2)]);
    expect(steps).toHaveLength(2);
    expect(trimmed).toBe(false);
  });

  it('keeps both ends when it has to drop turns', () => {
    /**
     * Not oldest-first like trimTranscript, which is right for a conversation being CONTINUED. A
     * trace is read afterwards by someone asking what it was trying to do (the opening) or what
     * went wrong (the end). Dropping either end answers only half the question.
     */
    const many = Array.from({ length: 60 }, (_, i) => step(i + 1, 4000));
    const { steps, trimmed } = trimTrace(many);
    expect(trimmed).toBe(true);
    expect(steps.length).toBeLessThan(many.length);
    // The approach survives...
    expect(steps.slice(0, KEEP_OPENING).map((s) => s.step)).toEqual([1, 2, 3]);
    // ...and so does the ending.
    expect(steps[steps.length - 1]!.step).toBe(60);
  });

  it('stays inside the budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => step(i + 1, 4000));
    const { steps } = trimTrace(many);
    expect(JSON.stringify(steps).length).toBeLessThanOrEqual(MAX_TRACE_CHARS);
  });

  it('reports how many turns are missing', () => {
    // A trimmed trace that did not say so would read as a shorter run than actually happened.
    expect(droppedCount({ steps: [step(1)], totalSteps: 12 })).toBe(11);
    expect(droppedCount({ steps: [step(1)], totalSteps: 1 })).toBe(0);
  });
});
