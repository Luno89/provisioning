import { describe, expect, it } from 'vitest';
import axios from 'axios';
import express from 'express';
import http from 'node:http';
import { currentTraceId, withSpan } from '@koala/engine-core/telemetry';
import { tracedClient, tracedTemporal, tracedWorker } from '../../workflows/testing/traced-temporal.js';
import { WorkspaceConclusionService } from '../../memory/services/WorkspaceConclusionService.js';
import { MetricsService, TRACE_ID_HEADER } from '../services/MetricsService.js';
import { carryingTrace, telemetrySettings } from './telemetry.js';
import { testDatabase } from './test-database.js';
import { createWorkspaceProjectActivities } from '../../activities/WorkspaceProjectActivity.js';

const TREE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const traced = tracedTemporal();

describe('the settings every process starts telemetry with', () => {
  it('names the service, the role and the instance, and exports only where the environment names a collector', () => {
    expect(telemetrySettings({ role: { role: 'root' }, telemetry: {} }, 'koala-backend')).toEqual({ service: 'koala-backend', role: 'root', sink: undefined });
    const settings = telemetrySettings({ role: { role: 'instance' }, telemetry: { instanceId: 'inst-1', version: 'abc123', otlpEndpoint: 'http://c:4318' } }, 'koala-worker-engine');
    expect(settings).toMatchObject({ service: 'koala-worker-engine', role: 'instance', instanceId: 'inst-1', version: 'abc123' });
    expect(settings.sink).toBeDefined();
    expect(telemetrySettings({ role: { role: 'root' }, telemetry: { cluster: 'root' } }, 'koala-backend')).toMatchObject({ role: 'root', cluster: 'root' });
  });
});

describe('one trace from the request through the workflow to the activity', () => {
  it('carries the request\'s trace into the workflow it starts and on to the activity the worker runs', async () => {
    const taskQueue = `telemetry-test-${Math.random().toString(36).slice(2, 8)}`;
    const client = tracedClient(traced.env);
    const inActivity: (string | undefined)[] = [];
    const worker = await tracedWorker(traced.env, taskQueue, 'ConcludeWorkspaceWorkflow.ts', { ConcludeWorkspaceActivity: async () => { inActivity.push(currentTraceId()); return { saved: true, owner: 'koala-u1', repo: 'tree-t1', commit: 'c0ffee' }; }, ...createWorkspaceProjectActivities(await testDatabase()) });

    const metrics = new MetricsService({ role: 'instance' });
    const app = express();
    app.use(metrics.middleware());
    app.post('/api/trees/:id/conclude', (req, res) => {
      const service = new WorkspaceConclusionService({ workflows: async () => client.workflow, taskQueue, projectOf: async () => undefined });
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
    await traced.telemetry.flush();
    const mine = traced.spans.filter((span) => span.traceId === callerTrace);
    const names = mine.map((span) => span.name);
    expect(names).toEqual(expect.arrayContaining(['the caller', 'POST /api/trees/:id/conclude', 'workflow.start ConcludeWorkspaceWorkflow', 'activity ConcludeWorkspaceActivity']));
    expect(names.join(' ')).not.toContain(TREE);
    const request = mine.find((span) => span.name === 'POST /api/trees/:id/conclude')!;
    const start = mine.find((span) => span.name === 'workflow.start ConcludeWorkspaceWorkflow')!;
    const activity = mine.find((span) => span.name === 'activity ConcludeWorkspaceActivity')!;
    expect(start.parentSpanId).toBe(request.spanId);
    expect(activity.parentSpanId).toBe(start.spanId);
  });
});
