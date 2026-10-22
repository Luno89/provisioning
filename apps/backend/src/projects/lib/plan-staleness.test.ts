import { describe, expect, it } from 'vitest';
import { staleBecause } from './plan-staleness.js';

const replan = { leafPlan: { treeId: 't', leafId: 'l0', leafTitle: 'The sandbox facts', mode: 'replan' as const, why: 'it failed', brief: 'again', tasks: [] } };

describe('a card about a story that has moved on', () => {
  it('is out of date once the story it would replan has succeeded, been cancelled or gone', () => {
    expect(staleBecause(replan, [{ id: 'l0', title: 'The sandbox facts', status: 'failed' }])).toBeUndefined();
    expect(staleBecause(replan, [{ id: 'l0', title: 'The sandbox facts', status: 'succeeded' }])).toBe('"The sandbox facts" has succeeded since this was proposed');
    expect(staleBecause(replan, [{ id: 'l0', title: 'The sandbox facts', status: 'cancelled' }])).toBe('"The sandbox facts" was cancelled since this was proposed');
    expect(staleBecause(replan, [])).toBe('the story "The sandbox facts" is gone');
  });

  it('is out of date when a story a change was about finished after it was proposed, not when it already had', () => {
    const change = (status: string) => ({ change: { treeId: 't', why: 'w', before: [{ leafId: 'l1', title: 'Labels', status, dependsOn: [], tasks: [] }], outcome: [] } });
    expect(staleBecause(change('running'), [{ id: 'l1', title: 'Labels', status: 'running' }])).toBeUndefined();
    expect(staleBecause(change('running'), [{ id: 'l1', title: 'Labels', status: 'succeeded' }])).toBe('"Labels" has succeeded since this was proposed');
    expect(staleBecause(change('succeeded'), [{ id: 'l1', title: 'Labels', status: 'succeeded' }])).toBeUndefined();
  });
});
