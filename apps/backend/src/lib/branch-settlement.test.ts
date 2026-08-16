import { describe, it, expect } from 'vitest';
import { settlementOf, summariseBranch, projectStanding, evidenceFor, citedSummary } from './branch-settlement.js';
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
    expect(standing.finishedLines.join('\n')).toContain('First run');
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
    expect(standing.outstanding).toEqual([
      { title: 'Broken thing', attempts: 2, from: 'First run', evidence: expect.stringContaining('2 attempts') },
    ]);
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
    // b2 produced nothing, so it is neither a finished run nor a live one.
    expect(standing.finishedLines.join('\n')).toContain('First run');
    expect(standing.finishedLines.join('\n')).not.toContain('Second run');
    expect(standing.liveBranches).toHaveLength(0);
  });
});


describe('citing what actually happened', () => {
  /**
   * ── WHY A COUNT IS NOT ENOUGH ──
   * "12 delivered, 2 not delivered" is only as trustworthy as whatever produced it, and half of
   * what finishes here is a model's report on its own work. Without saying WHAT was checked you
   * cannot tell twelve leaves that passed a test from twelve that merely said they were done — so
   * you cannot tell what is actually completed or what still needs doing.
   */
  it('never lets a report read like a check', () => {
    // The single most important line in this file. Softening it would launder a claim into a fact.
    const claimed = evidenceFor(leaf({ status: 'succeeded', verified: false }));
    expect(claimed).toMatch(/nothing checked it/i);
    expect(claimed).toMatch(/reported/i);

    const checked = evidenceFor(leaf({ status: 'succeeded', verified: true, merged: true }));
    expect(checked).not.toMatch(/reported/i);
    expect(checked).toMatch(/merged/i);
  });

  it('still says nothing checked it even when the work merged', () => {
    // Merging is not verification. A merged, unchecked leaf is the easiest one to mistake for done.
    expect(evidenceFor(leaf({ status: 'succeeded', verified: false, merged: true })))
      .toMatch(/nothing checked it/i);
  });

  it('names what was checked when the leaf promised files', () => {
    const e = evidenceFor(leaf({ status: 'succeeded', verified: true, merged: true, expects: ['src/client.js'] }));
    expect(e).toContain('src/client.js');
  });

  it('says work is checked but NOT merged, which needs a person', () => {
    /**
     * `verified` true with `merged` false means the merge conflicted or was rejected: the work is
     * intact on its branch and stuck. Reporting it as delivered would hide that.
     */
    const e = evidenceFor(leaf({ status: 'succeeded', verified: true, merged: false, outputBranch: 'koala/abc' }));
    expect(e).toMatch(/NOT merged/);
    expect(e).toContain('koala/abc');
  });

  it('carries the last error, because that is what decides a retry', () => {
    const e = evidenceFor(leaf({
      status: 'failed',
      attempts: [
        { attempt: 0, error: 'first thing broke', failedAt: '' },
        { attempt: 1, error: 'context_length_exceeded', failedAt: '' },
      ],
    }));
    expect(e).toContain('2 attempts');
    // The LAST error, not the first: it is the one that describes where things actually stand.
    expect(e).toContain('context_length_exceeded');
    expect(e).not.toContain('first thing broke');
  });

  it('clips a runaway error rather than pasting a wall into the prompt', () => {
    const e = evidenceFor(leaf({ status: 'failed', attempts: [{ attempt: 0, error: 'x'.repeat(5000), failedAt: '' }] }));
    expect(e.length).toBeLessThan(300);
    expect(e).toContain('…');
  });

  it('survives a failure with no recorded attempts', () => {
    // A leaf failed by something outside the retry loop has no attempt array; it must still report.
    expect(evidenceFor(leaf({ status: 'failed' }))).toBe('failed');
  });

  it('cites every undelivered and unchecked piece of a finished run', () => {
    const s = settlementOf([
      leaf({ id: 'a', title: 'Good', status: 'succeeded', verified: true, merged: true }),
      leaf({ id: 'b', title: 'Unchecked', status: 'succeeded', verified: false }),
      leaf({ id: 'c', title: 'Broken', status: 'failed', attempts: [{ attempt: 0, error: 'boom', failedAt: '' }] }),
    ]);
    const lines = citedSummary(branch({ title: 'The run' }), s).join('\n');
    expect(lines).toContain('not delivered — Broken');
    expect(lines).toContain('boom');
    // The unchecked one is named too: most likely to be wrong, least likely to be looked at.
    expect(lines).toContain('unchecked — Unchecked');
    // The verified one needs no citation beyond the count; it is the only list that is evidence.
    expect(lines).not.toContain('Good:');
  });

  it('names which acceptance check stopped the run', () => {
    // "The acceptance check failed" tells nobody which part broke.
    const s = settlementOf([leaf({ status: 'succeeded', verified: true })]);
    const lines = citedSummary(branch({ acceptanceOutcome: 'failed', acceptanceFailedCheck: 'tests pass' }), s).join('\n');
    expect(lines).toContain('acceptance stopped at: tests pass');
  });

  it('cites nothing for a run still in flight', () => {
    expect(citedSummary(branch(), settlementOf([leaf({ status: 'running' })]))).toEqual([]);
  });
});
