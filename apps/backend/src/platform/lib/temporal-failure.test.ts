import { describe, it, expect } from 'vitest';
import { failureReason } from './temporal-failure.js';

const wrapped = (message: string, outer = 'Workflow execution failed'): Error =>
  Object.assign(new Error(outer), { cause: Object.assign(new Error(message), { name: 'ImageBuildError' }) });

describe('what a failed run says it failed on', () => {
  it('takes the reason out from under the wrapper Temporal puts on it', () => {
    const err = wrapped('The workspace image did not build: No match for argument: jq-nonexistent');

    expect(failureReason('FAILED', err))
      .toBe('The workspace image did not build: No match for argument: jq-nonexistent');
  });

  it('walks a chain of wrappers down to the first thing that says something', () => {
    const inner = new Error('there is no agent called "ghost" with a procedure to judge this tree\'s leaves');
    const middle = Object.assign(new Error('Activity task failed'), { cause: inner });
    const outer = Object.assign(new Error('Workflow execution failed'), { cause: middle });

    expect(failureReason('FAILED', outer)).toBe(inner.message);
  });

  it('takes a plain error at its word', () => {
    expect(failureReason('FAILED', new Error('the sandbox pod never came up'))).toBe('the sandbox pod never came up');
  });

  it('falls back to the status word when nothing was said', () => {
    expect(failureReason('FAILED', undefined)).toBe('failed');
    expect(failureReason('TERMINATED', {})).toBe('terminated');
    expect(failureReason('TIMED_OUT', new Error('   '))).toBe('timed out');
  });

  it('says the wrapper rather than nothing when that is all there is', () => {
    expect(failureReason('FAILED', new Error('Workflow execution failed'))).toBe('Workflow execution failed');
  });

  it('stops walking a cause chain that goes around in circles', () => {
    const one = new Error('Workflow execution failed');
    const two = new Error('Activity task failed');
    one.cause = two;
    two.cause = one;

    expect(failureReason('FAILED', one)).toBe('Activity task failed');
  });
});
