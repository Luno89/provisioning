import { describe, it, expect } from 'vitest';
import { claimEvidence, nextLeafStep, type LeafTask } from './grove-leaf.js';

const task = (id: string, over: Partial<LeafTask> = {}): LeafTask => ({ id, title: `task ${id}`, status: 'accepted', dependsOn: [], ...over });

describe('nextLeafStep', () => {
  it('runs every task whose dependencies are finished, together', () => {
    expect(nextLeafStep([task('a'), task('b'), task('c', { dependsOn: ['a'] })], {})).toEqual({ kind: 'run', taskIds: ['a', 'b'] });
    expect(nextLeafStep([task('a', { status: 'done' }), task('c', { dependsOn: ['a'] })], {})).toEqual({ kind: 'run', taskIds: ['c'] });
  });

  it('claims only when every task is done or dropped', () => {
    expect(nextLeafStep([task('a', { status: 'done' }), task('b', { status: 'dropped' })], {})).toEqual({ kind: 'claim' });
    expect(nextLeafStep([task('a', { status: 'done' }), task('b')], {}).kind).toBe('run');
  });

  it('gives a failed task another go, then fails the leaf with its reason', () => {
    const failed = task('a', { status: 'failed', evidence: 'the judge did not accept the work' });
    expect(nextLeafStep([failed], { a: 1 })).toEqual({ kind: 'run', taskIds: ['a'] });
    expect(nextLeafStep([failed], { a: 2 })).toEqual({ kind: 'fail', reason: '"task a" failed 2 times: the judge did not accept the work' });
  });

  it('re-runs a task left running by a crash', () => {
    expect(nextLeafStep([task('a', { status: 'running' })], {})).toEqual({ kind: 'run', taskIds: ['a'] });
  });

  it('says a leaf with no accepted tasks is not broken down, rather than claiming it', () => {
    expect(nextLeafStep([], {})).toEqual({ kind: 'unbroken' });
    expect(nextLeafStep([task('a', { status: 'proposed' })], {})).toEqual({ kind: 'unbroken' });
  });
});

describe('claimEvidence', () => {
  it('is what each task reported and how it ended, with the runs that did it', () => {
    expect(claimEvidence([task('a', { status: 'done', evidence: 'wrote greet.js\nexit 0' }), { ...task('b', { status: 'done' }), runs: ['r1'] }]))
      .toBe('- task a [done]\n  wrote greet.js\n  exit 0\n- task b [done] (runs: r1)');
  });
});
