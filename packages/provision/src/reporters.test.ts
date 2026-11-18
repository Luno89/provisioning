import { describe, expect, it } from 'vitest';
import { memoryReporter } from '../testing/memory-reporter.js';
import { allReporters } from './reporters.js';
import { runSteps, StepFailed, type Reporter, type Step } from './steps.js';

const step = (id: string, fails?: string): Step<object> => ({
  id,
  title: `Making ${id}`,
  check: async () => ({ done: false, why: `${id} is not made` }),
  apply: async (_ctx, progress) => {
    progress.line(`making ${id}`);
    if (fails) throw new Error(fails);
  },
});

const quiet: Reporter = { started: () => undefined, alreadyDone: () => undefined, line: () => undefined, done: () => undefined, failed: () => undefined };

describe('allReporters', () => {
  it('tells every reporter each state and line, in order', async () => {
    const first = memoryReporter();
    const second = memoryReporter();
    const made = new Set<string>();
    const making: Step<object> = { id: 'a', title: 'Making a', check: async () => (made.has('a') ? { done: true } : { done: false, why: 'a is not made' }), apply: async (_ctx, progress) => { progress.line('making a'); made.add('a'); } };
    await runSteps([making, making], {}, allReporters(first, second));
    expect(first.reported).toEqual([
      { kind: 'started', id: 'a' },
      { kind: 'line', id: 'a', text: 'making a' },
      { kind: 'done', id: 'a' },
      { kind: 'started', id: 'a' },
      { kind: 'already-done', id: 'a' },
    ]);
    expect(second.reported).toEqual(first.reported);
  });

  it('waits for each reporter before the step goes on, and fails the run with a reporter\'s own error', async () => {
    const order: string[] = [];
    const slow: Reporter = { ...quiet, started: async () => { await new Promise((done) => setTimeout(done, 5)); order.push('told'); } };
    const making: Step<object> = { id: 'a', title: 'Making a', check: async () => (order.includes('made') ? { done: true } : { done: false, why: 'not made' }), apply: async () => { order.push('made'); } };
    await runSteps([making], {}, allReporters(memoryReporter(), slow));
    expect(order).toEqual(['told', 'made']);

    const refusing: Reporter = { ...quiet, started: async () => { throw new Error('root refused: 401'); } };
    await expect(runSteps([making], {}, allReporters(memoryReporter(), refusing))).rejects.toThrow('root refused: 401');
  });

  it('passes a failure to every reporter', async () => {
    const first = memoryReporter();
    const second = memoryReporter();
    const failure = await runSteps([step('a', 'the disk is full')], {}, allReporters(first, second)).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(StepFailed);
    expect(second.reported.at(-1)).toEqual({ kind: 'failed', id: 'a', why: 'the disk is full', tail: ['making a'] });
    expect(first.reported.at(-1)).toEqual(second.reported.at(-1));
  });
});
