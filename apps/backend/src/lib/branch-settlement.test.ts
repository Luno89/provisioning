import { describe, it, expect } from 'vitest';
import { settlementOf, summariseBranch, projectStanding, evidenceFor, citedSummary } from './branch-settlement.js';
import type { Branch, Leaf } from './leaves.js';

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
    expect(settlementOf([leaf({ status: 'proposed' })]).settled).toBe(false);
  });

  it('is not over while accepted work waits its turn', () => {
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
    expect(settlementOf([]).settled).toBe(false);
  });
});

describe('what a run left behind', () => {
  it('keeps a claim apart from a verification', () => {
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
    expect(settlementOf([leaf({ status: 'cancelled' })]).outstanding).toEqual([]);
  });
});

describe('the line a finished conversation collapses to', () => {
  it('says nothing at all for a run still in flight', () => {
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
    const s = settlementOf([leaf({ status: 'succeeded', verified: true })]);
    expect(summariseBranch(branch({ acceptanceOutcome: 'failed' }), s)).toContain('acceptance failed');
    expect(summariseBranch(branch({ acceptanceOutcome: 'passed' }), s)).toContain('acceptance passed');
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
    const standing = projectStanding([b1, b2], [
      leaf({ id: '1', branchId: 'b1', title: 'Done thing', status: 'succeeded', verified: true }),
      leaf({ id: '2', branchId: 'b2', title: 'In flight', status: 'running' }),
    ]);
    expect(standing.finishedLines.join('\n')).toContain('First run');
    expect(standing.liveBranches).toHaveLength(1);
    expect(standing.liveBranches[0]!.branch.id).toBe('b2');
  });

  it('lifts what was not delivered up to the project, with where it came from', () => {
    const standing = projectStanding([b1], [
      leaf({ id: '1', branchId: 'b1', title: 'Broken thing', status: 'failed',
        attempts: [{ attempt: 0, error: 'e', failedAt: '' }, { attempt: 1, error: 'e', failedAt: '' }] }),
    ]);
    expect(standing.outstanding).toEqual([
      { title: 'Broken thing', attempts: 2, from: 'First run', evidence: expect.stringContaining('2 attempts') },
    ]);
  });

  it('treats an unchecked claim as built rather than owed', () => {
    const standing = projectStanding([b1], [
      leaf({ id: '1', branchId: 'b1', title: 'Probably fine', status: 'succeeded', verified: false }),
    ]);
    expect(standing.delivered).toContain('Probably fine');
    expect(standing.outstanding).toEqual([]);
  });

  it('ignores a conversation that never produced anything', () => {
    const standing = projectStanding([b1, b2], [leaf({ id: '1', branchId: 'b1', status: 'succeeded' })]);
    expect(standing.finishedLines.join('\n')).toContain('First run');
    expect(standing.finishedLines.join('\n')).not.toContain('Second run');
    expect(standing.liveBranches).toHaveLength(0);
  });
});

describe('citing what actually happened', () => {
  it('never lets a report read like a check', () => {
    const claimed = evidenceFor(leaf({ status: 'succeeded', verified: false }));
    expect(claimed).toMatch(/nothing checked it/i);
    expect(claimed).toMatch(/reported/i);

    const checked = evidenceFor(leaf({ status: 'succeeded', verified: true, merged: true }));
    expect(checked).not.toMatch(/reported/i);
    expect(checked).toMatch(/merged/i);
  });

  it('still says nothing checked it even when the work merged', () => {
    expect(evidenceFor(leaf({ status: 'succeeded', verified: false, merged: true })))
      .toMatch(/nothing checked it/i);
  });

  it('names what was checked when the leaf promised files', () => {
    const e = evidenceFor(leaf({ status: 'succeeded', verified: true, merged: true, expects: ['src/client.js'] }));
    expect(e).toContain('src/client.js');
  });

  it('says work is checked but NOT merged, which needs a person', () => {
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
    expect(e).toContain('context_length_exceeded');
    expect(e).not.toContain('first thing broke');
  });

  it('clips a runaway error rather than pasting a wall into the prompt', () => {
    const e = evidenceFor(leaf({ status: 'failed', attempts: [{ attempt: 0, error: 'x'.repeat(5000), failedAt: '' }] }));
    expect(e.length).toBeLessThan(300);
    expect(e).toContain('…');
  });

  it('survives a failure with no recorded attempts', () => {
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
    expect(lines).toContain('unchecked — Unchecked');
    expect(lines).not.toContain('Good:');
  });

  it('names which acceptance check stopped the run', () => {
    const s = settlementOf([leaf({ status: 'succeeded', verified: true })]);
    const lines = citedSummary(branch({ acceptanceOutcome: 'failed', acceptanceFailedCheck: 'tests pass' }), s).join('\n');
    expect(lines).toContain('acceptance stopped at: tests pass');
  });

  it('cites nothing for a run still in flight', () => {
    expect(citedSummary(branch(), settlementOf([leaf({ status: 'running' })]))).toEqual([]);
  });
});
