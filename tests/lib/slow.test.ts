import { describe, expect, it } from 'vitest';
import { judgeLayer, judgeTests, prunedSlow } from './slow.js';

const unit = (name: string, seconds: number) => ({ name, tier: 'unit' as const, seconds });

describe('which tests over budget fail', () => {
  it('fails a held test over its budget that is not on the slow list, and only prints one on it', () => {
    const judged = judgeTests([unit('a.test.ts > one', 3), unit('a.test.ts > two', 2), unit('a.test.ts > fast', 0.1)], { 'a.test.ts > two': 1 }, ['a.test.ts']);
    expect(judged.failing).toEqual(['a.test.ts > one: 3 s, over the 1 s a unit test may take']);
    expect(judged.known).toEqual(['a.test.ts > two: 2 s, over the 1 s a unit test may take']);
  });

  it('only prints an integration test over its budget', () => {
    const judged = judgeTests([{ name: 'a.integration.test.ts > slow', tier: 'integration', seconds: 40 }], {}, ['a.integration.test.ts']);
    expect(judged.failing).toEqual([]);
    expect(judged.printed).toHaveLength(1);
  });

  it('lists a key of a file that ran and was not over budget, never one of a file that did not run or a layer', () => {
    const slow = { 'a.test.ts > fixed': 1, 'b.test.ts > not run': 1, 'layer unit': 1 };
    expect(judgeTests([unit('a.test.ts > fixed', 0.2)], slow, ['a.test.ts']).stale).toEqual(['a.test.ts > fixed']);
  });
});

describe('which layers over budget fail', () => {
  it('fails a layer over its budget unless it is on the list', () => {
    expect(judgeLayer('component', 400, {}).failing).toContain('the component layer took');
    expect(judgeLayer('component', 400, { 'layer component': 1 }).failing).toBeUndefined();
    expect(judgeLayer('component', 400, { 'layer component': 1 }).known).toBeDefined();
  });

  it('lists a layer on the list that was within budget', () => {
    expect(judgeLayer('component', 20, { 'layer component': 1 })).toEqual({ stale: 'layer component' });
    expect(judgeLayer('component', 20, {})).toEqual({});
  });
});

describe('pruning the slow list', () => {
  it('drops the keys named and keeps the rest', () => {
    expect(prunedSlow({ a: 1, b: 1, 'layer unit': 1 }, ['a'])).toEqual({ b: 1, 'layer unit': 1 });
  });
});
