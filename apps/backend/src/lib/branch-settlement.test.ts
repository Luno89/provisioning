import { describe, it, expect } from 'vitest';
import { settlementOf, summariseBranch, projectStanding } from './branch-settlement.js';
import type { Branch, Leaf } from './leaves.js';

/**
 * Whether a run is over, and what it left behind.
 *
 * The failure this whole file exists to prevent is quiet: a run finishes, its failures stay in the
 * branch forever, and the project's "needs attention" list only ever grows. Measured on this
 * instance, three failures from the previous night's run were still at the top of the page the next
 * day, indistinguishable from something that had just broken.
 *
 * So the tests below are aimed at the ways "is it over" and "what is still owed" could each be
 * plausibly wrong, rather than at the lines that compute them.
 */

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Do a thing',
  column: 'todo', status: 'succeeded', depth: 0, blocking: true,
  createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z',
  ...over,
} as Leaf);

const branch = (over: Partial<Branch> = {}): Branch => ({
  id: 'b1', ownerId: 'u1', title: 'Build the thing', messages: [],
  createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z',
  ...over,
} as Branch);

describe('whether a run is over', () => {
  it('is not over while anything is running', () => {
    expect(settlementOf([leaf({ status: 'running' })]).settled).toBe(false);
  });

  it('is not over while a proposal is awaiting a decision', () => {
    /**
     * A proposal cannot move without a person, but the run is not FINISHED — settling it would
     * discard work nobody has said no to, and the summary would claim the conversation was done
     * when it was actually waiting on you.
     */
    expect(settlementOf([leaf({ status: 'proposed' })]).settled).toBe(false);
  });

  it('is not over while accepted work waits its turn', () => {
    // `pending` means accepted and queued. It will move on its own; settling it strands it.
    expect(settlementOf([leaf({ status: 'pending' })]).settled).toBe(false);
  });

  it('is over when everything has finished, failed or been cancelled', () => {
    expect(settlementOf([
      leaf({ id: 'a', status: 'succeeded' }),
      leaf({ id: 'b', status: 'failed' }),
      leaf({ id: 'c', status: 'cancelled' }),
    ]).settled).toBe(true);
  });

  it('is not over for a conversation that has produced nothing', () => {
    /**
     * An empty branch is a conversation that has not started, not one that finished with nothing.
     * Calling it settled would file a brand-new chat under "completed runs".
     */
    expect(settlementOf([]).settled).toBe(false);
  });
});

describe('what a run left behind', () => {
  it('keeps a claim apart from a verification', () => {
    // The distinction every surface here preserves. A summary is read fastest, so it matters most.
    const s = settlementOf([
      leaf({ id: 'a', status: 'succeeded', verified: true }),
      leaf({ id: 'b', status: 'succeeded', verified: false }),
    ]);
    expect(s.delivered.map((l) => l.id)).toEqual(['a']);
    expect(s.claimed.map((l) => l.id)).toEqual(['b']);
  });

  it('counts a failure as still owed', () => {
    expect(settlementOf([leaf({ status: 'failed' })]).outstanding).toHaveLength(1);
  });

  it('does not owe anything for work that was cancelled', () => {
    /**
     * Somebody stopped it deliberately. Putting it on the re-proposal list would undo that decision
     * on their behalf, every time the project is planned again.
     */
    expect(settlementOf([leaf({ status: 'cancelled' })]).outstanding).toEqual([]);
  });
});

describe('the line a finished conversation collapses to', () => {
  it('says nothing at all for a run still in flight', () => {
    // Half a summary is worse than none: it would read as a finished run that achieved little.
    expect(summariseBranch(branch(), settlementOf([leaf({ status: 'running' })]))).toBe('');
  });

  it('counts each outcome separately', () => {
    const s = settlementOf([
      leaf({ id: 'a', status: 'succeeded', verified: true }),
      leaf({ id: 'b', status: 'succeeded', verified: false }),
      leaf({ id: 'c', status: 'failed' }),
    ]);
    const line = summariseBranch(branch({ title: 'Add search' }), s);
    expect(line).toContain('Add search');
    expect(line).toContain('1 delivered');
    expect(line).toContain('1 claimed but unchecked');
    expect(line).toContain('1 not delivered');
  });

  it('reports the acceptance verdict separately from the counts', () => {
    // Acceptance is about the REQUEST; folding it into the leaf counts would conflate two questions.
    const s = settlementOf([leaf({ status: 'succeeded', verified: true })]);
    expect(summariseBranch(branch({ acceptanceOutcome: 'failed' }), s)).toContain('acceptance failed');
    expect(summariseBranch(branch({ acceptanceOutcome: 'passed' }), s)).toContain('acceptance passed');
    // Unknown is not a pass and must not be reported as one.
    expect(summariseBranch(branch({ acceptanceOutcome: 'unknown' }), s)).not.toMatch(/acceptance (passed|failed)/);
  });

  it('says so plainly when a run finished having achieved nothing', () => {
    const s = settlementOf([leaf({ status: 'cancelled' })]);
    expect(summariseBranch(branch(), s)).toContain('nothing finished');
  });
});

describe('where a project stands', () => {
  const b1 = branch({ id: 'b1', title: 'First run' });
  const b2 = branch({ id: 'b2', title: 'Second run' });

  it('collapses finished conversations and leaves live ones as leaves', () => {
    /**
     * The point of the whole exercise. A finished run is one line; a run in flight is its detail,
     * because a sibling conversation needs to know what is being worked on right now in order to
     * stay out of its way.
     */
    const standing = projectStanding([b1, b2], [
      leaf({ id: '1', branchId: 'b1', title: 'Done thing', status: 'succeeded', verified: true }),
      leaf({ id: '2', branchId: 'b2', title: 'In flight', status: 'running' }),
    ]);
    expect(standing.summaries).toHaveLength(1);
    expect(standing.summaries[0]).toContain('First run');
    expect(standing.liveBranches).toHaveLength(1);
    expect(standing.liveBranches[0]!.branch.id).toBe('b2');
  });

  it('lifts what was not delivered up to the project, with where it came from', () => {
    /**
     * The failure stops being a permanent row in a branch and becomes something the project has to
     * decide about. Naming the run it came from is what makes that decision possible.
     */
    const standing = projectStanding([b1], [
      leaf({ id: '1', branchId: 'b1', title: 'Broken thing', status: 'failed',
        attempts: [{ attempt: 0, error: 'e', failedAt: '' }, { attempt: 1, error: 'e', failedAt: '' }] }),
    ]);
    expect(standing.outstanding).toEqual([{ title: 'Broken thing', attempts: 2, from: 'First run' }]);
  });

  it('treats an unchecked claim as built rather than owed', () => {
    // Unchecked is not the same as absent. Rebuilding it would be a worse answer than the missing
    // check.
    const standing = projectStanding([b1], [
      leaf({ id: '1', branchId: 'b1', title: 'Probably fine', status: 'succeeded', verified: false }),
    ]);
    expect(standing.delivered).toContain('Probably fine');
    expect(standing.outstanding).toEqual([]);
  });

  it('ignores a conversation that never produced anything', () => {
    // Otherwise every abandoned chat becomes a "run" in the project's history.
    const standing = projectStanding([b1, b2], [leaf({ id: '1', branchId: 'b1', status: 'succeeded' })]);
    expect(standing.summaries).toHaveLength(1);
    expect(standing.liveBranches).toHaveLength(0);
  });
});
