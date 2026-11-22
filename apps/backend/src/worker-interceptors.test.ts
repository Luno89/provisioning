import { afterEach, describe, expect, it, vi } from 'vitest';
import { onceTemporalAnswers } from './worker-interceptors.js';

const saying = () => ({ tag: '[ClusterWorker]', logger: { warn: vi.fn() }, dependencies: { failed: vi.fn() } });

const outcomeOf = (started: Promise<unknown>): Promise<unknown> => started.then((worker) => ({ worker }), (err: unknown) => ({ err }));

afterEach(() => { vi.useRealTimers(); });

describe('a backend worker started once Temporal answers', () => {
  it('stops with why at once when the worker can never be made, as when its workflows do not bundle, and never says Temporal is down', async () => {
    vi.useFakeTimers();
    const said = saying();
    const start = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins'))
      .mockResolvedValue('worker');
    const outcome = outcomeOf(onceTemporalAnswers(start, said));
    await vi.runAllTimersAsync();
    const { err } = await outcome as { err?: Error };
    expect(err?.message).toBe('[ClusterWorker] cannot start: UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins');
    expect(start).toHaveBeenCalledTimes(1);
    expect(said.dependencies.failed).not.toHaveBeenCalled();
  });

  it('says Temporal is down while it cannot be reached and starts the worker once it answers', async () => {
    vi.useFakeTimers();
    const said = saying();
    const unreachable = Object.assign(new Error('Connection refused'), { name: 'TransportError' });
    const start = vi.fn<() => Promise<string>>().mockRejectedValueOnce(unreachable).mockResolvedValue('worker');
    const outcome = outcomeOf(onceTemporalAnswers(start, said));
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ worker: 'worker' });
    expect(said.dependencies.failed).toHaveBeenCalledWith('temporal', unreachable);
  });
});
