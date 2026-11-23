import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { DependencyReporter } from '../../platform/lib/dependencies.js';
import { reopening } from '@koala/engine-core/reopening';
import { runAskingVia, runCancelledVia, runClosedVia, runEndedVia, runWaitingVia } from './run-cancellation.js';

const unavailable = () => Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
const notFound = () => Object.assign(new Error('workflow not found'), { name: 'WorkflowNotFoundError' });

function temporal(handle: { query?: () => Promise<unknown>; describe?: () => Promise<unknown> }) {
  const client = { workflow: { getHandle: vi.fn(() => handle) } } as unknown as Client;
  const thrown = new Error('Temporal isn\'t answering since 10:02 UTC: it is unavailable');
  const reporter = { failed: vi.fn(() => thrown), answered: vi.fn() } satisfies DependencyReporter;
  return { client: async () => client, reporter, thrown };
}

describe('what a run\'s state read from Temporal answers', () => {
  it('answers what Temporal says, and that it answered', async () => {
    const { client, reporter } = temporal({ query: async () => ({ cancelled: true, rounds: 1, asking: ['call-1'], waitsFor: ['decide'] }) });
    expect(await runCancelledVia(client, reporter)('run-1')).toBe(true);
    expect(await runAskingVia(client, reporter)('run-1')).toEqual(['call-1']);
    expect(await runWaitingVia(client, reporter)('run-1')).toEqual({ asking: ['call-1'], waitsFor: ['decide'] });
    expect(reporter.answered).toHaveBeenCalledWith('temporal');
  });

  it('takes a run Temporal no longer has as not stopped by anyone, asking and waiting for nothing, and ended', async () => {
    const { client, reporter } = temporal({ query: async () => { throw notFound(); }, describe: async () => { throw notFound(); } });
    expect(await runCancelledVia(client, reporter)('run-1')).toBe(false);
    expect(await runAskingVia(client, reporter)('run-1')).toEqual([]);
    expect(await runWaitingVia(client, reporter)('run-1')).toEqual({ asking: [], waitsFor: [] });
    expect(await runEndedVia(client, reporter)('run-1')).toBe(true);
    expect(reporter.failed).not.toHaveBeenCalled();
  });

  it('never answers when Temporal could not be asked: it says so through the dependency\'s state', async () => {
    const { client, reporter, thrown } = temporal({ query: async () => { throw unavailable(); }, describe: async () => { throw unavailable(); } });
    await expect(runCancelledVia(client, reporter)('run-1')).rejects.toBe(thrown);
    await expect(runAskingVia(client, reporter)('run-1')).rejects.toBe(thrown);
    await expect(runWaitingVia(client, reporter)('run-1')).rejects.toBe(thrown);
    await expect(runEndedVia(client, reporter)('run-1')).rejects.toBe(thrown);
    expect(reporter.failed).toHaveBeenCalledTimes(4);
    expect(reporter.failed).toHaveBeenCalledWith('temporal', expect.objectContaining({ code: 14 }));
  });

  it('reads a run as ended once its workflow closed or moved on to another run', async () => {
    const running = (memo: Record<string, unknown> = {}) => temporal({ describe: async () => ({ status: { name: 'RUNNING' }, memo }) });
    expect(await runEndedVia(running().client)('run-1')).toBe(false);
    expect(await runEndedVia(running({ runId: 'run-2' }).client)('run-1')).toBe(true);
    expect(await runEndedVia(temporal({ describe: async () => ({ status: { name: 'COMPLETED' } }) }).client)('run-1')).toBe(true);
  });
});

describe('waiting for a run to close', () => {
  it('ends with Temporal\'s reason once it refuses to say how the run stands for good', async () => {
    const refused = Object.assign(new Error('3 INVALID_ARGUMENT: the run id is not one Temporal takes'), { code: 3 });
    const described = vi.fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(refused)
      .mockResolvedValue({ status: { name: 'COMPLETED' } });
    const client = { workflow: { getHandle: vi.fn(() => ({ result: async () => undefined, describe: described })) } } as unknown as Client;
    await expect(runClosedVia(async () => client, undefined, () => reopening(0))('run-1', 'owner')).rejects.toBe(refused);
  });
});
