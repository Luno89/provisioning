import { describe, expect, it } from 'vitest';
import type { Worker } from '@temporalio/worker';
import { currentTraceId, withSpan } from '@koala/engine-core/telemetry';
import { tracedClient, tracedTemporal, tracedWorker } from './testing/traced-temporal.js';
import type { TraceProbeActivities } from './testing/trace-probe-workflow.js';
import { testClient } from '@koala/engine-core/testing/temporal';

const traced = tracedTemporal();

const probeWorker = async (taskQueue: string, seen: Map<string, string | undefined>): Promise<Worker> => {
  const activities: TraceProbeActivities = {
    Probe: async (label) => { seen.set(label, currentTraceId()); },
  };
  return tracedWorker(traced.env, taskQueue, 'testing/trace-probe-workflow.ts', activities);
};

describe('the trace a workflow was started under follows its activities and children, in a real workflow', () => {
  it('reaches an activity, a local activity, a child workflow and the run continue-as-new starts', async () => {
    const taskQueue = `trace-probe-${Math.random().toString(36).slice(2, 8)}`;
    const client = tracedClient(traced.env);
    const seen = new Map<string, string | undefined>();
    const worker = await probeWorker(taskQueue, seen);

    let started: string | undefined;
    await worker.runUntil(async () => {
      await withSpan('the caller', {}, async () => {
        started = currentTraceId();
        await client.workflow.execute('traceProbeWorkflow', { taskQueue, workflowId: `trace-probe-${taskQueue}`, args: [{ label: 'run', continueOnce: true }] });
      });
    });

    expect(started).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.fromEntries(seen)).toEqual({
      'run activity': started,
      'run local activity': started,
      'run child activity': started,
      'run continued activity': started,
      'run continued local activity': started,
      'run continued child activity': started,
    });
  });

  it('gives an activity of a workflow started outside any trace a trace of its own, not the last workflow\'s', async () => {
    const taskQueue = `trace-probe-${Math.random().toString(36).slice(2, 8)}`;
    const client = testClient(traced.env);
    const seen = new Map<string, string | undefined>();
    const worker = await probeWorker(taskQueue, seen);

    await worker.runUntil(client.workflow.execute('traceProbeWorkflow', { taskQueue, workflowId: `trace-probe-${taskQueue}`, args: [{ label: 'bare', continueOnce: false }] }));

    const traces = new Set([...seen.values()]);
    expect(seen.size).toBe(3);
    expect(traces.has(undefined)).toBe(false);
    expect(traces.size).toBe(3);
  });
});
