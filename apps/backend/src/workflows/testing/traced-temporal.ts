import { afterAll, beforeAll } from 'vitest';
import { Client } from '@temporalio/client';
import type { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { traceActivities, traceWorkflowStarts, type TelemetrySignal, type TelemetrySink } from '@koala/engine-core/telemetry';
import { startTelemetry, type Telemetry } from '@koala/engine-core/telemetry-sdk';
import { temporalTestEnvironment } from './temporal-test-env.js';
import { testWorker } from './test-worker.js';

export interface SentSpan { name: string; traceId: string; spanId: string; parentSpanId?: string }

export interface TracedTemporal {
  readonly env: TestWorkflowEnvironment;
  readonly telemetry: Telemetry;
  readonly spans: SentSpan[];
}

export function tracedTemporal(): TracedTemporal {
  const spans: SentSpan[] = [];
  const sink: TelemetrySink = {
    async send(signal: TelemetrySignal, body: Uint8Array) {
      if (signal !== 'traces') return;
      const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as { resourceSpans: { scopeSpans: { spans: SentSpan[] }[] }[] };
      for (const resource of parsed.resourceSpans) for (const scope of resource.scopeSpans) spans.push(...scope.spans);
    },
  };
  let env: TestWorkflowEnvironment | undefined;
  let telemetry: Telemetry | undefined;
  beforeAll(async () => {
    telemetry = startTelemetry({ service: 'koala-test', sink, spanDelayMs: 10, metricsEveryMs: 50, log: () => undefined });
    env = await temporalTestEnvironment();
  });
  afterAll(async () => {
    await env?.teardown();
    await telemetry?.shutdown();
  });
  const made = <T>(thing: T | undefined): T => {
    if (thing === undefined) throw new Error('this file\'s telemetry and Temporal environment are made in beforeAll; a test reached them before they were made');
    return thing;
  };
  return {
    get env() { return made(env); },
    get telemetry() { return made(telemetry); },
    spans,
  };
}

export const tracedClient = (env: TestWorkflowEnvironment): Client =>
  new Client({ connection: env.connection, namespace: env.namespace ?? 'default', interceptors: { workflow: [traceWorkflowStarts()] } });

export const tracedWorker = (env: TestWorkflowEnvironment, taskQueue: string, workflows: string, activities: object): Promise<Worker> =>
  testWorker(env, { taskQueue, workflows, workflowInterceptors: ['telemetry-interceptors.ts'], activityInterceptors: [traceActivities()], activities });
