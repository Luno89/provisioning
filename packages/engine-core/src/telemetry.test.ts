import { afterEach, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import {
  contextFromHeaders, currentTraceId, headerPayload, koalaMetrics, telemetryStarted, textOfHeader,
  traceActivities, traceWorkflowStarts, tracingHeaders, withSpan, type TelemetrySink, type TelemetrySignal,
} from './telemetry.js';
import { envSink, logOnce, otlpHttpSink, startTelemetry, type Telemetry } from './telemetry-sdk.js';

interface SentBatch { signal: TelemetrySignal; body: unknown }

const collecting = (): TelemetrySink & { sent: SentBatch[] } => {
  const sent: SentBatch[] = [];
  return { sent, async send(signal, body) { sent.push({ signal, body: JSON.parse(Buffer.from(body).toString('utf8')) }); } };
};

const spanNames = (sent: SentBatch[]): string[] => sent
  .filter((batch) => batch.signal === 'traces')
  .flatMap((batch) => (batch.body as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] }).resourceSpans)
  .flatMap((resource) => resource.scopeSpans)
  .flatMap((scope) => scope.spans.map((span) => span.name));

const spansSent = (sent: SentBatch[]) => sent
  .filter((batch) => batch.signal === 'traces')
  .flatMap((batch) => (batch.body as { resourceSpans: { scopeSpans: { spans: { name: string; traceId: string; parentSpanId?: string; spanId: string; attributes: { key: string; value: unknown }[] }[] }[] }[] }).resourceSpans)
  .flatMap((resource) => resource.scopeSpans)
  .flatMap((scope) => scope.spans);

const metricNames = (sent: SentBatch[]): string[] => sent
  .filter((batch) => batch.signal === 'metrics')
  .flatMap((batch) => (batch.body as { resourceMetrics: { scopeMetrics: { metrics: { name: string }[] }[] }[] }).resourceMetrics)
  .flatMap((resource) => resource.scopeMetrics)
  .flatMap((scope) => scope.metrics.map((metric) => metric.name));

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let telemetry: Telemetry | undefined;
afterEach(async () => { await telemetry?.shutdown(); telemetry = undefined; });

describe('Koala\'s telemetry', () => {
  it('starts without an exporter when no collector is named, so spans end and nothing is sent', async () => {
    expect(envSink({})).toBeUndefined();
    telemetry = startTelemetry({ service: 'koala-test', spanDelayMs: 10, metricsEveryMs: 50, log: () => undefined });
    expect(telemetry.exporting).toBe(false);
    expect(telemetryStarted()).toBe(true);
    await withSpan('something', { count: 1 }, async () => 'done');
    koalaMetrics().workFailures.add(1, { kind: 'chat' });
    await telemetry.flush();
    expect(startTelemetry({ service: 'again' })).toBe(telemetry);
  });

  it('sends spans and metrics as OTLP JSON to the sink it is given, naming the service as a resource', async () => {
    const sink = collecting();
    telemetry = startTelemetry({ service: 'koala-test', role: 'combined', sink, spanDelayMs: 10, metricsEveryMs: 50, log: () => undefined });
    expect(telemetry.exporting).toBe(true);
    const value = await withSpan('model.call', { 'koala.model.name': 'glm' }, async (span) => {
      expect(currentTraceId()).toBe(span.spanContext().traceId);
      return 42;
    });
    expect(value).toBe(42);
    koalaMetrics().workFailures.add(1, { kind: 'chat' });
    koalaMetrics().httpRequestSeconds.record(0.2, { method: 'GET', route: '/api/projects', status: '200' });
    await settle(120);
    await telemetry.flush();
    expect(spanNames(sink.sent)).toContain('model.call');
    const resource = (sink.sent.find((batch) => batch.signal === 'traces')!.body as { resourceSpans: { resource: { attributes: { key: string; value: { stringValue: string } }[] } }[] }).resourceSpans[0]!.resource.attributes;
    expect(resource).toEqual(expect.arrayContaining([
      { key: 'service.name', value: { stringValue: 'koala-test' } },
      { key: 'koala.role', value: { stringValue: 'combined' } },
    ]));
    expect(metricNames(sink.sent)).toEqual(expect.arrayContaining(['koala_work_failures', 'koala_http_request_seconds', 'koala_up']));
  });

  it('switches where it exports to while running, and drops quietly while there is nowhere to send', async () => {
    telemetry = startTelemetry({ service: 'koala-test', spanDelayMs: 10, metricsEveryMs: 50, log: () => undefined });
    await withSpan('before', {}, async () => undefined);
    await settle(40);
    const sink = collecting();
    telemetry.exportTo(sink);
    await withSpan('after', {}, async () => undefined);
    await settle(40);
    await telemetry.flush();
    expect(spanNames(sink.sent)).toEqual(['after']);
  });

  it('logs once when the collector does not answer, once more when it does again, and never fails the work', async () => {
    const lines: string[] = [];
    let down = true;
    const sink: TelemetrySink = { async send() { if (down) throw new Error('ECONNREFUSED'); } };
    telemetry = startTelemetry({ service: 'koala-test', sink, spanDelayMs: 10, metricsEveryMs: 50, log: (line) => lines.push(line) });
    for (let round = 0; round < 3; round += 1) {
      await withSpan(`round ${round}`, {}, async () => undefined);
      await settle(40);
      await telemetry.flush();
    }
    expect(lines.filter((line) => line.includes('traces are not reaching'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('metrics are not reaching')).length).toBeLessThanOrEqual(1);
    down = false;
    await withSpan('recovered', {}, async () => undefined);
    await settle(40);
    await telemetry.flush();
    expect(lines.filter((line) => line.includes('traces reach the collector again'))).toHaveLength(1);
  });

  it('keeps one send in flight per signal and drops the batch that would pile up behind it', async () => {
    const lines: string[] = [];
    const held: (() => void)[] = [];
    const sends: TelemetrySignal[] = [];
    let holding = true;
    const sink: TelemetrySink = { send(signal) { sends.push(signal); return holding ? new Promise<void>((resolve) => { held.push(resolve); }) : Promise.resolve(); } };
    const report = logOnce((line) => lines.push(line));
    telemetry = startTelemetry({ service: 'koala-test', sink, spanDelayMs: 10, metricsEveryMs: 5_000, log: (line) => lines.push(line) });
    await withSpan('first', {}, async () => undefined);
    await settle(40);
    await withSpan('second', {}, async () => undefined);
    await settle(40);
    expect(sends.filter((signal) => signal === 'traces')).toHaveLength(1);
    expect(lines.filter((line) => line.includes('batch of traces was dropped'))).toHaveLength(1);
    holding = false;
    for (const release of held) release();
    report.dropped('traces');
    report.dropped('traces');
    expect(lines.filter((line) => line.includes('was dropped'))).toHaveLength(2);
  });

  it('posts each signal to the collector\'s OTLP path, and refuses when no collector is reachable yet', async () => {
    const posted: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      posted.push({ url: String(url), body: Buffer.from(init!.body as Buffer).toString('utf8') });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await otlpHttpSink(() => 'http://10.0.0.5:4318/', fetchImpl).send('traces', new TextEncoder().encode('{"resourceSpans":[]}'));
    expect(posted).toEqual([{ url: 'http://10.0.0.5:4318/v1/traces', body: '{"resourceSpans":[]}' }]);
    await expect(otlpHttpSink(() => undefined, fetchImpl).send('metrics', new Uint8Array())).rejects.toThrow('no collector is reachable yet');
    const refusing = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(otlpHttpSink(() => 'http://c:4318', refusing).send('metrics', new Uint8Array())).rejects.toThrow('503');
    expect(envSink({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }, fetchImpl)).toBeDefined();
  });

  it('carries the trace through Temporal headers: a workflow start adds them and an activity continues the same trace', async () => {
    const sink = collecting();
    telemetry = startTelemetry({ service: 'koala-test', sink, spanDelayMs: 10, metricsEveryMs: 50, log: () => undefined });
    const starts = traceWorkflowStarts();
    let carried: Record<string, unknown> = {};
    const outerTrace = await withSpan('http GET /api/engine/runs', {}, async () => {
      await starts.start({ workflowType: 'AgentRunWorkflow', headers: {}, options: { workflowId: 'run-1', taskQueue: 'engine-queue' } }, async (input) => {
        carried = input.headers;
        return 'started';
      });
      return currentTraceId();
    });
    expect(textOfHeader(carried.traceparent as never)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(textOfHeader(carried.traceparent as never)).toContain(outerTrace);

    const activity = traceActivities()({ info: { activityType: 'EngineModelTurnActivity', attempt: 2, taskQueue: 'engine-queue', workflowType: 'AgentRunWorkflow', workflowExecution: { workflowId: 'run-1', runId: 'r' } } });
    const seen = await activity.inbound.execute({ headers: carried as never, args: [] }, async () => currentTraceId());
    expect(seen).toBe(outerTrace);
    await expect(activity.inbound.execute({ headers: carried as never, args: [] }, async () => { throw new Error('broke'); })).rejects.toThrow('broke');

    await settle(120);
    await telemetry.flush();
    const spans = spansSent(sink.sent);
    const names = spans.map((span) => span.name);
    expect(names).toEqual(expect.arrayContaining(['http GET /api/engine/runs', 'workflow.start AgentRunWorkflow', 'activity EngineModelTurnActivity']));
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    const start = spans.find((span) => span.name === 'workflow.start AgentRunWorkflow')!;
    const act = spans.find((span) => span.name === 'activity EngineModelTurnActivity')!;
    expect(act.parentSpanId).toBe(start.spanId);
    expect(act.attributes).toEqual(expect.arrayContaining([{ key: 'temporal.activity.attempt', value: { intValue: 2 } }]));
    expect(metricNames(sink.sent)).toEqual(expect.arrayContaining(['koala_workflows_started', 'koala_activity_seconds', 'koala_activity_retries']));
  });

  it('reads only well-formed trace headers, and an empty carrier gives the active context', () => {
    expect(textOfHeader(undefined)).toBeUndefined();
    expect(textOfHeader({ data: new TextEncoder().encode('not json') })).toBeUndefined();
    expect(textOfHeader({ data: new TextEncoder().encode('{"a":1}') })).toBeUndefined();
    expect(textOfHeader(headerPayload('00-abc-def-01'))).toBe('00-abc-def-01');
    expect(contextFromHeaders(undefined)).toBe(context.active());
    expect(trace.getSpan(contextFromHeaders({}))).toBeUndefined();
    expect(Object.keys(tracingHeaders(context.active()))).toEqual([]);
  });
});
