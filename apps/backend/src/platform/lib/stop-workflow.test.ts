import { describe, it, expect } from 'vitest';
import { cancelIfRunning, type CancellableWorkflow } from './stop-workflow.js';

const handle = (over: Partial<CancellableWorkflow> & { status?: string } = {}) => {
  const calls: string[] = [];
  const workflow: CancellableWorkflow = {
    describe: async () => ({ status: { name: over.status ?? 'RUNNING' } }),
    cancel: async () => { calls.push('cancel'); },
    result: async () => { calls.push('result'); throw new Error('Workflow execution cancelled'); },
    ...over,
  };
  return { workflow, calls };
};

describe('stopping a workflow', () => {
  it('cancels it, so it can finish its own ending, and waits for Temporal to say it closed', async () => {
    const { workflow, calls } = handle();
    expect(await cancelIfRunning(workflow)).toBe('cancelled');
    expect(calls).toEqual(['cancel', 'result']);
  });

  it('never ends it any other way: one that has not closed is still being stopped', async () => {
    let closes!: () => void;
    const { workflow, calls } = handle({ result: () => { calls.push('result'); return new Promise<void>((done) => { closes = done; }); } });
    let settled = false;
    const stopping = cancelIfRunning(workflow).then((how) => { settled = true; return how; });
    await new Promise((done) => setImmediate(done));
    expect(settled).toBe(false);
    expect(calls).toEqual(['cancel', 'result']);
    closes();
    expect(await stopping).toBe('cancelled');
  });

  it('leaves alone what is not running or no longer exists', async () => {
    expect(await cancelIfRunning(handle({ status: 'COMPLETED' }).workflow)).toBe('not-running');
    expect(await cancelIfRunning(handle({ describe: async () => { throw new Error('workflow not found for ID: x'); } }).workflow)).toBe('not-running');
  });

  it('counts one that finished on its own between looking and cancelling as not running', async () => {
    const { workflow } = handle({ cancel: async () => { throw new Error('workflow execution not found'); } });
    expect(await cancelIfRunning(workflow)).toBe('not-running');
  });
});
