import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import axios from 'axios';
import express from 'express';
import http from 'node:http';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTraceId, traceActivities, traceWorkflowStarts, withSpan, type TelemetrySignal, type TelemetrySink } from '@koala/engine-core/telemetry';
import { startTelemetry, type Telemetry } from '@koala/engine-core/telemetry-sdk';
import { temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { WorkspaceConclusionService } from '../../memory/services/WorkspaceConclusionService.js';
import { MetricsService, TRACE_ID_HEADER } from '../services/MetricsService.js';
import { carryingTrace, telemetrySettings } from './telemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TREE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

interface SentSpan { name: string; traceId: string; spanId: string; parentSpanId?: string }

const collecting = () => {
  const spans: SentSpan[] = [];
  const sink: TelemetrySink = {
    async send(signal: TelemetrySignal, body: Uint8Array) {
      if (signal !== 'traces') return;
      const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as { resourceSpans: { scopeSpans: { spans: SentSpan[] }[] }[] };
      for (const resource of parsed.resourceSpans) for (const scope of resource.scopeSpans) spans.push(...scope.spans);
    },
  };
  return { sink, spans };
};

let env: TestWorkflowEnvironment;
let telemetry: Telemetry;
const sent = collecting();

beforeAll(async () => {
  telemetry = startTelemetry({ service: 'koala-test', sink: sent.sink, spanDelayMs: 10, metricsEveryMs: 50, log: () => undefined });
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
  await telemetry?.shutdown();
});

describe('the settings every process starts telemetry with', () => {
  it('names the service, the role and the instance, and exports only where the environment names a collector', () => {
    expect(telemetrySettings({}, 'koala-backend')).toEqual({ service: 'koala-backend', role: 'combined', sink: undefined });
    const settings = telemetrySettings({ ROLE: 'instance', INSTANCE_ID: 'inst-1', KOALA_VERSION: 'abc123', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }, 'koala-worker-engine');
    expect(settings).toMatchObject({ service: 'koala-worker-engine', role: 'instance', instanceId: 'inst-1', version: 'abc123' });
    expect(settings.sink).toBeDefined();
  });
});

describe('one trace from the request through the workflow to the activity', () => {
  it('carries the request\'s trace into the workflow it starts and on to the activity the worker runs', async () => {
    const taskQueue = `telemetry-test-${Math.random().toString(36).slice(2, 8)}`;
    const client = new Client({ connection: env.connection, namespace: env.namespace ?? 'default', interceptors: { workflow: [traceWorkflowStarts()] } });
    const inActivity: (string | undefined)[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: resolve(__dirname, '../../workflows/ConcludeWorkspaceWorkflow.ts'),
      interceptors: { activity: [traceActivities()], workflowModules: [resolve(__dirname, '../../workflows/telemetry-interceptors.ts')] },
      activities: { ConcludeWorkspaceActivity: async () => { inActivity.push(currentTraceId()); return { saved: true, owner: 'koala-u1', repo: 'tree-t1', commit: 'c0ffee' }; } },
    });

    const metrics = new MetricsService({ role: 'combined' });
    const app = express();
    app.use(metrics.middleware());
    app.post('/api/trees/:id/conclude', (req, res) => {
      const service = new WorkspaceConclusionService({ workflows: async () => client.workflow, taskQueue });
      service.conclude('u1', { kind: 'tree', id: String(req.params.id) }).then((saved) => res.json(saved), (err: Error) => res.status(500).json({ error: err.message }));
    });
    const server = http.createServer(app);
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    const port = (server.address() as { port: number }).port;

    let requestTrace: string | undefined;
    let callerTrace: string | undefined;
    await worker.runUntil(async () => {
      await withSpan('the caller', {}, async () => {
        callerTrace = currentTraceId();
        const answer = await carryingTrace(axios.create({ baseURL: `http://127.0.0.1:${port}`, proxy: false, validateStatus: () => true })).post(`/api/trees/${TREE}/conclude`);
        expect(answer.data).toEqual({ saved: true, owner: 'koala-u1', repo: 'tree-t1', commit: 'c0ffee' });
        requestTrace = answer.headers[TRACE_ID_HEADER] as string;
      });
    });
    server.close();

    expect(requestTrace).toBe(callerTrace);
    expect(inActivity).toEqual([callerTrace]);
    await telemetry.flush();
    const mine = sent.spans.filter((span) => span.traceId === callerTrace);
    const names = mine.map((span) => span.name);
    expect(names).toEqual(expect.arrayContaining(['the caller', 'POST /api/trees/:id/conclude', 'workflow.start ConcludeWorkspaceWorkflow', 'activity ConcludeWorkspaceActivity']));
    expect(names.join(' ')).not.toContain(TREE);
    const request = mine.find((span) => span.name === 'POST /api/trees/:id/conclude')!;
    const start = mine.find((span) => span.name === 'workflow.start ConcludeWorkspaceWorkflow')!;
    const activity = mine.find((span) => span.name === 'activity ConcludeWorkspaceActivity')!;
    expect(start.parentSpanId).toBe(request.spanId);
    expect(activity.parentSpanId).toBe(start.spanId);
  }, 90_000);
});
