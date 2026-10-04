import { describe, it, expect } from 'vitest';
import { claimEvidence, claimEvidenceFor, nextLeafStep, leavesNeedingPlan, runEvidence, workEnding, type LeafTask } from './grove-leaf.js';

const task = (id: string, over: Partial<LeafTask> = {}): LeafTask => ({ id, title: `task ${id}`, status: 'accepted', dependsOn: [], runs: [], ...over });

describe('nextLeafStep', () => {
  it('runs every task whose dependencies are finished, together', () => {
    expect(nextLeafStep([task('a'), task('b'), task('c', { dependsOn: ['a'] })])).toEqual({ kind: 'run', taskIds: ['a', 'b'] });
    expect(nextLeafStep([task('a', { status: 'done' }), task('c', { dependsOn: ['a'] })])).toEqual({ kind: 'run', taskIds: ['c'] });
  });

  it('claims only when every task is done or dropped', () => {
    expect(nextLeafStep([task('a', { status: 'done' }), task('b', { status: 'dropped' })])).toEqual({ kind: 'claim' });
    expect(nextLeafStep([task('a', { status: 'done' }), task('b')]).kind).toBe('run');
  });

  it('stops the work as soon as a task fails, with what it reported, so the judge looks at it rather than it being worked again', () => {
    const failed = task('a', { status: 'failed', runs: ['run-1'], evidence: 'the endpoint never answered' });
    expect(nextLeafStep([failed])).toEqual({ kind: 'stopped', taskIds: ['a'], reason: '"task a" failed: the endpoint never answered' });
  });

  it('stops even while other tasks could still run, and names every task that failed', () => {
    const step = nextLeafStep([task('a', { status: 'failed' }), task('b', { status: 'failed', evidence: 'no build' }), task('c')]);
    expect(step).toEqual({ kind: 'stopped', taskIds: ['a', 'b'], reason: '"task a" failed; "task b" failed: no build' });
  });

  it('re-runs a task left running by a crash', () => {
    expect(nextLeafStep([task('a', { status: 'running' })])).toEqual({ kind: 'run', taskIds: ['a'] });
  });

  it('says a leaf with no accepted tasks is not broken down, rather than claiming it', () => {
    expect(nextLeafStep([])).toEqual({ kind: 'unbroken' });
    expect(nextLeafStep([task('a', { status: 'proposed' })])).toEqual({ kind: 'unbroken' });
  });
});

describe('workEnding', () => {
  const run = (outcome: string, outputs: Record<string, unknown> = {}, reason?: string) => ({ outcome, ...(reason ? { reason } : {}), outputs });

  it('claims on ok', () => {
    expect(workEnding(run('ok', { step: 'claim' }), 'leaf-worker')).toEqual({ kind: 'claimed' });
  });

  it('sends the leaf back to the planner only when next_leaf_task said it has no tasks', () => {
    expect(workEnding(run('refused', { step: 'unbroken' }, 'the leaf had no tasks yet'), 'leaf-worker')).toEqual({ kind: 'unbroken' });
  });

  it('fails a leaf whose run was refused for any other reason, saying so', () => {
    expect(workEnding(run('refused', undefined, 'the persona may not use write_file'), 'paper-writer'))
      .toEqual({ kind: 'failed', reason: 'the paper-writer run was refused: the persona may not use write_file' });
  });

  it('carries the tool\'s own reason for a failure rather than the procedure\'s fixed words', () => {
    expect(workEnding(run('failed', { step: 'fail', reason: '"task a" failed 2 times: the build is broken' }, 'a task of the leaf failed twice — the result carries the reason'), 'leaf-worker'))
      .toEqual({ kind: 'failed', reason: '"task a" failed 2 times: the build is broken' });
  });

  it('falls back to the run\'s reason, then to naming the agent', () => {
    expect(workEnding(run('exhausted', undefined, 'stopped after 10000 steps'), 'leaf-worker')).toEqual({ kind: 'failed', reason: 'stopped after 10000 steps' });
    expect(workEnding(run('failed'), 'leaf-worker')).toEqual({ kind: 'failed', reason: 'the leaf-worker run did not finish this leaf' });
  });
});

describe('claimEvidence', () => {
  it('is what each task reported and how it ended, with the runs that did it', () => {
    expect(claimEvidence([task('a', { status: 'done', evidence: 'wrote greet.js\nexit 0' }), { ...task('b', { status: 'done' }), runs: ['r1'] }]))
      .toBe('- task a [done]\n  wrote greet.js\n  exit 0\n- task b [done] (runs: r1)');
  });
});

describe('what a claim carries when no task spoke for the leaf', () => {
  it('takes the run\'s own words, named', () => {
    expect(runEvidence({ result: 'Wrote paper.md, with a source for each claim.', message: 'not this' }))
      .toBe('result: Wrote paper.md, with a source for each claim.');
  });

  it('says nothing about outputs that are not words', () => {
    expect(runEvidence({ count: 3, blank: '', missing: undefined })).toBe('');
  });

  it('cuts a long answer down to what a claim can carry', () => {
    expect(runEvidence({ result: 'x'.repeat(5000) }, 100)).toHaveLength(101);
  });

  it('takes the tasks\' evidence when a task reported something, and leaves the run out of it', () => {
    expect(claimEvidenceFor([task('a', { status: 'done', evidence: 'wrote greet.js' })], 'the run said this'))
      .toBe('- task a [done]\n  wrote greet.js');
  });

  it('adds the run\'s account when a task was taken but reported nothing', () => {
    expect(claimEvidenceFor([task('a', { status: 'accepted' })], 'Wrote paper.md, with a source for each claim.'))
      .toBe('- task a [accepted]\nWrote paper.md, with a source for each claim.');
  });

  it('falls back to the run alone with no tasks, and to saying nothing with neither', () => {
    expect(claimEvidenceFor([task('a', { status: 'proposed' })], 'the run said this')).toBe('the run said this');
    expect(claimEvidenceFor([], undefined)).toBe('no task reported anything');
  });
});

describe('leavesNeedingPlan', () => {
  const leaf = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `leaf ${id}`, status: 'pending', ...over });

  it('replans a failed leaf with everything that failed, and breaks down a pending one with no work', () => {
    const needs = leavesNeedingPlan(
      [leaf('f', { status: 'failed', findings: 'nginx is not installed', review: { reason: 'nothing served :8080' } }), leaf('e'), leaf('w')],
      [{ ...task('t1', { status: 'failed', evidence: 'apt-get: permission denied' }), leafId: 'f' }, { ...task('t2', { status: 'accepted' }), leafId: 'w' }],
      new Set(),
    );

    expect(needs).toEqual([
      { leafId: 'f', leafTitle: 'leaf f', leafBody: '', mode: 'replan', failure: 'Why the leaf failed: nginx is not installed\nThe judge said: nothing served :8080\n- task "task t1" failed: apt-get: permission denied' },
      { leafId: 'e', leafTitle: 'leaf e', leafBody: '', mode: 'breakdown' },
    ]);
  });

  it('replans a failed leaf that carries no runner field, because nothing ever wrote one', () => {
    // The guard this replaced asked for `runner === 'engine'`, and no code set it — so in the live
    // grove a failed leaf was never replanned and a leaf with no tasks was never broken down.
    const needs = leavesNeedingPlan(
      [{ id: 'l1', title: 'leaf l1', status: 'failed', review: { reason: 'its own checks failed' } }],
      [],
      new Set(),
    );

    expect(needs).toEqual([
      { leafId: 'l1', leafTitle: 'leaf l1', leafBody: '', mode: 'replan', failure: 'The judge said: its own checks failed' },
    ]);
  });

  it('leaves alone a leaf that already has a proposal waiting', () => {
    expect(leavesNeedingPlan([leaf('proposed', { status: 'failed' })], [], new Set(['proposed']))).toEqual([]);
  });

  it('replans a failed leaf however many times it has been replanned, unless the type says otherwise', () => {
    const worn = [leaf('worn', { status: 'failed', replans: 7 })];

    // No bound by default: every replan is a proposal a person approves, and a run has its own pass cap.
    expect(leavesNeedingPlan(worn, [], new Set()).map((need) => need.leafId)).toEqual(['worn']);
    expect(leavesNeedingPlan(worn, [], new Set(), { attempts: 2 })).toEqual([]);
    expect(leavesNeedingPlan(worn, [], new Set(), { attempts: 8 }).map((need) => need.leafId)).toEqual(['worn']);
  });

  it('takes 0 as never, so a failed leaf is left for the person', () => {
    expect(leavesNeedingPlan([leaf('f', { status: 'failed' })], [], new Set(), { attempts: 0 })).toEqual([]);
  });
});

