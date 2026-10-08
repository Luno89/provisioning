import { describe, it, expect } from 'vitest';
import { conflictTask, landedLeaf, landingOrder, readyToLand, reopenForConflict, SUPERSEDED_NOTE, supersededByVerdict } from './landing.js';
import type { Task } from '../engine-host/tools/tasks.js';
import type { Leaf } from './leaves.js';

const leaf = (id: string, over: Partial<Leaf> = {}): Leaf => ({ id, ownerId: 'u1', branchId: 'b1', title: `leaf ${id}`, status: 'succeeded', verified: true, createdAt: 'then', updatedAt: 'then', ...over });

describe('landing leaves', () => {
  it('lands only verified, settled leaves that have not landed yet', () => {
    expect(readyToLand(leaf('a'))).toBe(true);
    expect(readyToLand(leaf('b', { verified: false }))).toBe(false);
    expect(readyToLand(leaf('c', { status: 'claimed' }))).toBe(false);
    expect(readyToLand(leaf('d', { landed: { at: 'then', outcome: 'merged' } }))).toBe(false);
  });

  it('lands a leaf after the leaves it depends on', () => {
    expect(landingOrder([leaf('c', { dependsOn: ['b'] }), leaf('b', { dependsOn: ['a'] }), leaf('a')]).map((one) => one.id)).toEqual(['a', 'b', 'c']);
    expect(landingOrder([leaf('x', { dependsOn: ['y'] }), leaf('y', { dependsOn: ['x'] })])).toHaveLength(2);
  });

  it('records a landing', () => {
    expect(landedLeaf(leaf('a'), 'merged', 'now')).toMatchObject({ landed: { at: 'now', outcome: 'merged' }, updatedAt: 'now' });
  });

  it('turns a conflict into work: the leaf waits again with a task to merge main in, checked by whether main really is in it', () => {
    const reopened = reopenForConflict(leaf('a', { tasks: ['t1'], claim: { evidence: 'x', at: 'then', commit: 'c0ffee' }, review: { verdict: 'sound', at: 'then' } }), 't-merge', 'now');

    expect(reopened).toMatchObject({ status: 'pending', verified: false, tasks: ['t1', 't-merge'] });
    expect(reopened.claim).toBeUndefined();
    expect(reopened.review).toBeUndefined();
    expect(conflictTask(leaf('a')).checks).toEqual({ command: 'git merge-base --is-ancestor main HEAD && echo merged', expects: ['merged'] });
  });
});

describe('tasks a verdict superseded', () => {
  const at = '2026-10-06T00:00:00.000Z';
  const task = (id: string, leafId: string, status: Task['status'], evidence?: string): Task => ({ id, ownerId: 'u', leafId, title: id, doneMeans: 'x', dependsOn: [], status, runs: [], createdAt: '', updatedAt: '', ...(evidence ? { evidence } : {}) });

  it('drops only that leaf\'s failed tasks, keeping why each failed', () => {
    const dropped = supersededByVerdict([task('a1', 'a', 'failed', 'timed out'), task('a2', 'a', 'done'), task('b1', 'b', 'failed')], 'a', at);

    expect(dropped).toEqual([{ ...task('a1', 'a', 'dropped'), evidence: `timed out\n${SUPERSEDED_NOTE}`, updatedAt: at }]);
  });
});
