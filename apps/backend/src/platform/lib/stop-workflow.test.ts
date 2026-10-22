import { describe, it, expect, vi } from 'vitest';
import { stopIfRunning, type StoppableWorkflow } from './stop-workflow.js';

const handle = (over: Partial<StoppableWorkflow> & { status?: string } = {}) => {
  const calls: string[] = [];
  const workflow: StoppableWorkflow = {
    describe: async () => ({ status: { name: over.status ?? 'RUNNING' } }),
    cancel: async () => { calls.push('cancel'); },
    result: async () => { calls.push('result'); throw new Error('Workflow execution cancelled'); },
    terminate: async (reason) => { calls.push(`terminate: ${reason}`); },
    ...over,
  };
  return { workflow, calls };
};

describe('stopping a workflow', () => {
  it('cancels it, so it can finish its own ending, and waits for it to close', async () => {
    const { workflow, calls } = handle();
    expect(await stopIfRunning(workflow, 'the account was removed')).toBe('cancelled');
    expect(calls).toEqual(['cancel', 'result']);
  });

  it('terminates it only when it has not closed in time after being cancelled', async () => {
    vi.useFakeTimers();
    const { workflow, calls } = handle({ result: () => new Promise(() => undefined) });
    const stopping = stopIfRunning(workflow, 'the account was removed', 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stopping).toBe('terminated');
    expect(calls).toEqual(['cancel', 'terminate: the account was removed — it did not stop within 1s of being cancelled']);
    vi.useRealTimers();
  });

  it('leaves alone what is not running or no longer exists', async () => {
    expect(await stopIfRunning(handle({ status: 'COMPLETED' }).workflow, 'x')).toBe('not-running');
    expect(await stopIfRunning(handle({ describe: async () => { throw new Error('workflow not found for ID: x'); } }).workflow, 'x')).toBe('not-running');
  });

  it('counts one that finished on its own between looking and cancelling as stopped', async () => {
    const { workflow } = handle({ cancel: async () => { throw new Error('workflow execution not found'); } });
    expect(await stopIfRunning(workflow, 'x')).toBe('cancelled');
  });
});
