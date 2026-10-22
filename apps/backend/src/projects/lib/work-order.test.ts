import { describe, it, expect } from 'vitest';
import { orderProblem, ranked, workOrder } from './work-order.js';

describe('the order work is taken in', () => {
  it('takes stories feature by feature in the features\' order, each feature\'s stories in theirs, unranked ones last by age', () => {
    const branches = [{ id: 'b1', priority: 1 }, { id: 'b2', priority: 0 }, { id: 'b3' }];
    const leaves = [
      { id: 'old', branchId: 'b1', createdAt: '2026-10-01' },
      { id: 'top', branchId: 'b1', priority: 0, createdAt: '2026-10-05' },
      { id: 'unranked-feature', branchId: 'b3', priority: 0 },
      { id: 'first-feature', branchId: 'b2', createdAt: '2026-10-09' },
    ];
    expect(workOrder(leaves, branches).map((leaf) => leaf.id)).toEqual(['first-feature', 'top', 'old', 'unranked-feature']);
  });

  it('refuses an order that is not a list of ids, repeats one, or names something outside', () => {
    expect(orderProblem('a', ['a'], 'stories')).toBe('send the stories in their new order, as a list of ids');
    expect(orderProblem(['a', 'a'], ['a'], 'stories')).toBe('a story appears twice in the order');
    expect(orderProblem(['a', 'x'], ['a'], 'features')).toBe('x is not among the features here');
    expect(orderProblem(['a'], ['a', 'b'], 'stories')).toBeUndefined();
  });

  it('gives each item its place, saving only the ones whose place changed', () => {
    const items = [{ id: 'a', priority: 0, updatedAt: 't' }, { id: 'b', updatedAt: 't' }];
    expect(ranked(items, ['a', 'b'], 'now')).toEqual([{ id: 'b', priority: 1, updatedAt: 'now' }]);
  });
});
