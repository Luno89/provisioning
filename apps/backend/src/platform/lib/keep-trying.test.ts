import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { keepPlatformWorkflowRunning, keepTrying, stopsNamingWith } from './keep-trying.js';
import { OWNER_ATTRIBUTE } from './workflow-owner.js';

afterEach(() => { vi.useRealTimers(); });

const notUpYet = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7233'), { code: 'ECONNREFUSED' });
const refusedForGood = () => Object.assign(new Error('7 PERMISSION_DENIED: the namespace refuses this client'), { code: 7 });

describe('keeping on trying to reach something that is not up yet', () => {
  it('says whether the first try worked, and keeps trying, 5 s doubling to a minute, until one does', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    const gaveUp: string[] = [];
    let tries = 0;
    const first = await keepTrying('Temporal', async () => { tries += 1; if (tries < 4) throw notUpYet(); }, (message) => said.push(message), (reason) => gaveUp.push(reason));
    expect(first).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toBe(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tries).toBe(4);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tries).toBe(4);
    expect(said).toEqual([
      'Temporal: it refused the connection (ECONNREFUSED); trying again in 5 s',
      'Temporal: it refused the connection (ECONNREFUSED); trying again in 10 s',
      'Temporal: it refused the connection (ECONNREFUSED); trying again in 20 s',
    ]);
    expect(gaveUp).toEqual([]);
  });

  it('stops at a failure that is final, on the first try or a later one, and hands its reason to the caller', async () => {
    vi.useFakeTimers();
    const gaveUp: string[] = [];
    let tries = 0;
    const first = await keepTrying('Temporal', async () => { tries += 1; throw tries < 2 ? notUpYet() : refusedForGood(); }, () => undefined, (reason) => gaveUp.push(reason));
    expect(first).toBe(false);
    expect(gaveUp).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tries).toBe(2);
    expect(gaveUp).toEqual(['7 PERMISSION_DENIED: the namespace refuses this client']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tries).toBe(2);
    expect(await keepTrying('Temporal', async () => { throw refusedForGood(); }, () => undefined, (reason) => gaveUp.push(reason))).toBe(false);
    expect(gaveUp).toHaveLength(2);
  });
});

describe('keeping a platform workflow running', () => {
  it('starts it as the platform\'s, takes one already running as started, and keeps trying while Temporal is not up yet', async () => {
    vi.useFakeTimers();
    const asked: unknown[] = [];
    let tries = 0;
    const stopped: string[] = [];
    keepPlatformWorkflowRunning({
      start: async (options) => { asked.push(options); tries += 1; if (tries === 1) throw notUpYet(); throw new WorkflowExecutionAlreadyStartedError('running', 'sweep', 'Sweep'); },
      workflowId: 'sweep', taskQueue: 'engine', waiting: '[files] the sweep has not started yet', refused: 'Starting the sweep',
      stopsNaming: (what, reason) => stopped.push(`${what}: ${reason}`), log: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tries).toBe(2);
    expect(asked[0]).toEqual({ workflowId: 'sweep', taskQueue: 'engine', args: [], typedSearchAttributes: [{ key: OWNER_ATTRIBUTE, value: 'platform' }] });
    expect(stopped).toEqual([]);
  });

  it('stops the process, naming it, once Temporal refuses the start for good', async () => {
    const stopped: string[] = [];
    keepPlatformWorkflowRunning({
      start: async () => { throw refusedForGood(); },
      workflowId: 'sweep', taskQueue: 'engine', waiting: '[files] the sweep has not started yet', refused: 'Starting the sweep',
      stopsNaming: (what, reason) => stopped.push(`${what}: ${reason}`), log: () => undefined,
    });
    await vi.waitFor(() => expect(stopped).toEqual(['Starting the sweep: 7 PERMISSION_DENIED: the namespace refuses this client']));
  });
});

describe('work a process needs, refused for good', () => {
  it('stops the process as failed, naming what was refused and why', () => {
    const said: string[] = [];
    const codes: number[] = [];
    stopsNamingWith((code) => codes.push(code), (line) => said.push(line))('Temporal', '7 PERMISSION_DENIED: the namespace refuses this client');
    expect(codes).toEqual([1]);
    expect(said).toEqual(['[bootstrap] Temporal was refused for good, so this process stops: 7 PERMISSION_DENIED: the namespace refuses this client']);
  });
});
