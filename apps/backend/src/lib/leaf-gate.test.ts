/**
 * The gate decides whether a leaf runs, waits, gives up, or was never supposed to wake at all.
 *
 * Every case here is one where getting it wrong is invisible: a leaf that parks forever looks like
 * a card that never moves, and a leaf that wakes when it should not spends real budget on work
 * nobody accepted. None of it shows up without a live Temporal server and a plan in flight.
 */
import { describe, it, expect } from 'vitest';
import { dependenciesMet, blockedBy, dependentsOf, readyToStart, shouldRetry, type Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l', ownerId: 'u1', branchId: 'b', title: 't', body: '', column: 'todo',
  status: 'pending', depth: 0, blocking: true, createdAt: '', updatedAt: '', ...over,
} as Leaf);

describe('who gets woken when a leaf finishes', () => {
  it('finds the leaves that named this one', () => {
    const a = leaf({ id: 'a' });
    const b = leaf({ id: 'b', dependsOn: ['a'] });
    const c = leaf({ id: 'c', dependsOn: ['other'] });

    expect(dependentsOf('a', [a, b, c]).map((l) => l.id)).toEqual(['b']);
  });

  it('wakes a dependent that is not yet ready', () => {
    /**
     * Deliberately NOT filtered by readiness. A leaf with two dependencies is woken by each of
     * them and decides for itself whether the last one has landed — the alternative is the waker
     * evaluating a DAG it only half-sees, and two dependencies finishing at once each concluding
     * the other would do it.
     */
    const a = leaf({ id: 'a', status: 'succeeded' });
    const b = leaf({ id: 'b', status: 'pending' });
    const c = leaf({ id: 'c', dependsOn: ['a', 'b'] });

    expect(dependentsOf('a', [a, b, c]).map((l) => l.id)).toEqual(['c']);
    expect(dependenciesMet(c, [a, b, c])).toBe(false);
  });

  it('finds nobody when nothing depended on it', () => {
    expect(dependentsOf('a', [leaf({ id: 'a' })])).toEqual([]);
  });
});

describe('when a leaf may proceed', () => {
  it('waits while a dependency is still running', () => {
    const a = leaf({ id: 'a', status: 'running' });
    const b = leaf({ id: 'b', dependsOn: ['a'] });

    expect(dependenciesMet(b, [a, b])).toBe(false);
    expect(blockedBy(b, [a, b]).map((l) => l.id)).toEqual(['a']);
  });

  it('proceeds once every dependency has succeeded', () => {
    const a = leaf({ id: 'a', status: 'succeeded' });
    const b = leaf({ id: 'b', status: 'succeeded' });
    const c = leaf({ id: 'c', dependsOn: ['a', 'b'] });

    expect(dependenciesMet(c, [a, b, c])).toBe(true);
  });

  it('does not proceed on a FAILED dependency', () => {
    // The work is still expected, it just has not happened — a retry can still satisfy it.
    const a = leaf({ id: 'a', status: 'failed' });
    const b = leaf({ id: 'b', dependsOn: ['a'] });

    expect(dependenciesMet(b, [a, b])).toBe(false);
  });

  it('treats a deleted dependency as met rather than stranding the dependent', () => {
    // There is no future in which a removed leaf succeeds. Waiting would strand the dependent with
    // no way to clear it by hand; the ordering was already lost when the leaf was deleted.
    const b = leaf({ id: 'b', dependsOn: ['gone'] });
    expect(dependenciesMet(b, [b])).toBe(true);
  });
});

describe('a dependency that can never succeed', () => {
  it('is distinguishable from one that simply has not finished', () => {
    /**
     * The case the gate calls `abandon`. A cancelled dependency never becomes `succeeded`, so
     * without singling it out the dependent parks on an open workflow waiting for a signal that is
     * never coming — invisible except as a card that never moves.
     */
    const dead = leaf({ id: 'a', status: 'cancelled' });
    const waiting = leaf({ id: 'b', status: 'running' });
    const target = leaf({ id: 'c', dependsOn: ['a', 'b'] });
    const all = [dead, waiting, target];

    expect(dependenciesMet(target, all)).toBe(false);
    expect(blockedBy(target, all).some((b) => b.status === 'cancelled')).toBe(true);
  });

  it('treats a dependency that failed every attempt the same way', () => {
    /**
     * Observed: "Implement JSON config parser module" failed all three attempts, and the leaf that
     * depended on it sat `pending` with no workflow and no prospect of getting one — indefinitely,
     * and indistinguishable from work that simply had not started.
     */
    const spent = leaf({
      id: 'a', status: 'failed',
      attempts: [{ attempt: 0, error: 'x', failedAt: '' }, { attempt: 1, error: 'x', failedAt: '' }, { attempt: 2, error: 'x', failedAt: '' }],
    });
    const target = leaf({ id: 'b', dependsOn: ['a'] });

    expect(shouldRetry((spent.attempts ?? []).length)).toBe(false);
    expect(dependenciesMet(target, [spent, target])).toBe(false);
  });

  it('still waits on a failure that has retries left', () => {
    // A failure with attempts remaining is temporary: the retry reads a database — and now a
    // repository — the previous attempt changed, so the work is still expected.
    const retrying = leaf({ id: 'a', status: 'failed', attempts: [{ attempt: 0, error: 'x', failedAt: '' }] });

    expect(shouldRetry((retrying.attempts ?? []).length)).toBe(true);
  });

  it('leaves an ordinary blocked leaf alone', () => {
    const waiting = leaf({ id: 'a', status: 'running' });
    const target = leaf({ id: 'b', dependsOn: ['a'] });

    expect(blockedBy(target, [waiting, target]).some((b) => b.status === 'cancelled')).toBe(false);
  });
});

describe('the backstop', () => {
  it('claims nothing that already has a workflow', () => {
    // The gate claims the workflow id before it starts waiting, so a parked leaf must not look
    // startable to the backstop — otherwise the two race to start the same work.
    const a = leaf({ id: 'a', status: 'succeeded' });
    const parked = leaf({ id: 'b', dependsOn: ['a'], workflowId: 'leaf-b' });

    expect(readyToStart([a, parked])).toEqual([]);
  });

  it('still catches a ready leaf that nothing ever started', () => {
    // The case it exists for: a terminated workflow runs no activities, so nothing woke this.
    const a = leaf({ id: 'a', status: 'succeeded' });
    const stranded = leaf({ id: 'b', dependsOn: ['a'] });

    expect(readyToStart([a, stranded]).map((l) => l.id)).toEqual(['b']);
  });
});
