import { WORKER_DEFAULTS } from '@koala/engine-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTraceId, traceActivities, traceWorkflowStarts, withSpan, type TelemetrySignal, type TelemetrySink } from '@koala/engine-core/telemetry';
import { startTelemetry, type Telemetry } from '@koala/engine-core/telemetry-sdk';
import { temporalTestEnvironment } from './temporal-test-env.js';
import type { TraceProbeActivities } from './testing/trace-probe-workflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SentSpan { name: string; traceId: string; spanId: string; parentSpanId?: string }

let env: TestWorkflowEnvironment;
let telemetry: Telemetry;
const spans: SentSpan[] = [];

const sink: TelemetrySink = {
  async send(signal: TelemetrySignal, body: Uint8Array) {
    if (signal !== 'traces') return;
    const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as { resourceSpans: { scopeSpans: { spans: SentSpan[] }[] }[] };
    for (const resource of parsed.resourceSpans) for (const scope of resource.scopeSpans) spans.push(...scope.spans);
  },
};

beforeAll(async () => {
  telemetry = startTelemetry({ service: 'koala-test', sink, spanDelayMs: 10, metricsEveryMs: 50, log: () => undefined });
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
  await telemetry?.shutdown();
});

const probeWorker = (taskQueue: string, seen: Map<string, string | undefined>): Promise<Worker> => {
  const activities: TraceProbeActivities = {
    Probe: async (label) => { seen.set(label, currentTraceId()); },
  };
  return Worker.create({
    ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
    taskQueue,
    workflowsPath: resolve(__dirname, 'testing/trace-probe-workflow.ts'),
    interceptors: { activity: [traceActivities()], workflowModules: [resolve(__dirname, 'telemetry-interceptors.ts')] },
    activities,
  });
};

describe('the trace a workflow was started under follows its activities and children, in a real workflow', () => {
  it('reaches an activity, a local activity, a child workflow and the run continue-as-new starts', async () => {
    const taskQueue = `trace-probe-${Math.random().toString(36).slice(2, 8)}`;
    const client = new Client({ connection: env.connection, namespace: env.namespace ?? 'default', interceptors: { workflow: [traceWorkflowStarts()] } });
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
  }, 90_000);

  it('gives an activity of a workflow started outside any trace a trace of its own, not the last workflow\'s', async () => {
    const taskQueue = `trace-probe-${Math.random().toString(36).slice(2, 8)}`;
    const client = new Client({ connection: env.connection, namespace: env.namespace ?? 'default' });
    const seen = new Map<string, string | undefined>();
    const worker = await probeWorker(taskQueue, seen);

    await worker.runUntil(client.workflow.execute('traceProbeWorkflow', { taskQueue, workflowId: `trace-probe-${taskQueue}`, args: [{ label: 'bare', continueOnce: false }] }));

    const traces = new Set([...seen.values()]);
    expect(seen.size).toBe(3);
    expect(traces.has(undefined)).toBe(false);
    expect(traces.size).toBe(3);
  }, 90_000);
});
