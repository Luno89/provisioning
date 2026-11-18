import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import type { LoopbackRole } from '../platform/testing/roles-on-loopback.js';
import { otlpSink, type OtlpSink, type OtlpSpan } from '../platform/testing/otlp-sink.js';
import { startThreeRoles, until, type ThreeRoles } from '../platform/testing/three-roles.js';
import { TRACE_ID_HEADER } from '../platform/services/MetricsService.js';
import { TURN_PROCEDURE_ID } from '../checks/lib/turn-check.js';

const STAMP = Date.now().toString(36);
const SCENARIO = `telemetry-${STAMP}`;
const SAID = 'Hello from the scripted model, for the telemetry integration test.';
const ASKED = 'Say hello, nothing else.';

let collector: OtlpSink;
let roles: ThreeRoles;
let backend: LoopbackRole;
let worker: LoopbackRole;
let cookie: string;
let checkRunId: string | undefined;

async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await fetch(`${backend.url}${path}`, {
    method: init.method ?? 'GET',
    headers: { cookie, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as unknown };
}

beforeAll(async () => {
  collector = await otlpSink();
  roles = await startThreeRoles('telemetry', { extra: { OTEL_EXPORTER_OTLP_ENDPOINT: collector.url }, instanceWorkers: ['engine'] });
  backend = roles.instance;
  worker = roles.workers['instance-engine']!;
  cookie = await roles.ownerOnInstance();
});

afterAll(async () => {
  if (checkRunId) await until(async () => (((await call(`/api/evals/level2/runs/${checkRunId}`)).body as { state: string }).state === 'running' ? undefined : true));
  await roles?.close();
  await collector?.close();
});

describe('Koala reports its own telemetry to the collector it is pointed at', () => {
  let traceId: string;

  it('a turn check on a scripted model, started through the check runner, answers with its trace id', async () => {
    const saved = await call(`/api/evals/level2/scenarios/${SCENARIO}`, {
      method: 'PUT',
      body: {
        id: SCENARIO,
        name: 'Telemetry: a scripted hello',
        describe: 'One model turn on a script, so the request, the workflow start and the model call make one trace.',
        agent: 'koala',
        procedure: { id: TURN_PROCEDURE_ID },
        turn: true,
        input: { message: ASKED },
        script: { rules: [{ when: {}, reply: { say: SAID } }] },
        expect: { chooses: { tool: null } },
      },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const started = await call('/api/evals/level2/runs', { method: 'POST', body: { only: [SCENARIO] } });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    checkRunId = (started.body as { id: string }).id;
    traceId = started.headers.get(TRACE_ID_HEADER) ?? '';
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('one trace, found by that id, spans the request, the check workflow\'s start, the engine run\'s request, its workflow start, its activities and the model call, across both processes', async () => {
    onTestFailed(() => console.log(`backend:\n${backend.logs(120)}\n\nengine worker:\n${worker.logs(120)}\n\nspans of the trace: ${JSON.stringify(collector.spans().filter((span) => span.traceId === traceId).map((span) => `${span.service} ${span.name}`))}`));
    const wanted = ['POST /api/evals/level2/runs', 'workflow.start CheckRunWorkflow', 'POST /api/engine/runs', 'workflow.start AgentRunWorkflow', 'model.call'];
    const spans = await until(async () => {
      const inTrace = collector.spans().filter((span) => span.traceId === traceId);
      const names = inTrace.map((span) => span.name);
      const engineActivity = inTrace.some((span) => span.name.startsWith('activity ') && span.service === 'koala-worker-engine');
      const ids = new Set(inTrace.map((span) => span.spanId));
      const whole = inTrace.every((span) => !span.parentSpanId || ids.has(span.parentSpanId));
      return wanted.every((name) => names.includes(name)) && engineActivity && whole ? inTrace : undefined;
    });
    const named = (name: string): OtlpSpan => spans.find((span) => span.name === name)!;
    expect(named('POST /api/evals/level2/runs').service).toBe('koala-backend');
    expect(named('POST /api/evals/level2/runs').parentSpanId).toBeUndefined();
    expect(named('workflow.start CheckRunWorkflow').service).toBe('koala-backend');
    expect(named('model.call').attributes).toMatchObject({ 'koala.model.name': 'scripted', 'koala.model.outcome': 'ok', 'koala.model.finish_reason': 'stop', 'koala.model.tool_calls': 0 });
    const parentOf = (span: OtlpSpan): OtlpSpan | undefined => spans.find((one) => one.spanId === span.parentSpanId);
    const runner = parentOf(named('POST /api/engine/runs'));
    expect(runner?.service).toBe('koala-worker-engine');
    expect(runner?.name).toMatch(/^activity /);
  });

  it('the metrics arrive by their names, each labelled with the process that reported it', async () => {
    const wanted: [string, string][] = [
      ['koala_up', 'koala-backend'],
      ['koala_up', 'koala-worker-engine'],
      ['koala_http_request_seconds', 'koala-backend'],
      ['koala_workflows_started', 'koala-backend'],
      ['koala_activity_seconds', 'koala-worker-engine'],
      ['koala_model_call_seconds', 'koala-backend'],
    ];
    await until(async () => {
      const metrics = collector.metrics();
      return wanted.every(([name, service]) => metrics.some((metric) => metric.name === name && metric.service === service && metric.points.length > 0)) ? true : undefined;
    });
    const metrics = collector.metrics();
    const points = (name: string) => metrics.filter((metric) => metric.name === name).flatMap((metric) => metric.points);
    expect(points('koala_http_request_seconds').map((point) => point.route)).toContain('/api/evals/level2/runs');
    expect(points('koala_workflows_started').map((point) => point['workflow.type'])).toEqual(expect.arrayContaining(['CheckRunWorkflow', 'AgentRunWorkflow']));
    expect(points('koala_model_call_seconds')).toContainEqual(expect.objectContaining({ model: 'scripted', outcome: 'ok' }));
  });

  it('nothing the person asked or the model said reaches the collector', () => {
    expect(collector.received.length).toBeGreaterThan(0);
    for (const batch of collector.received) {
      expect(batch.raw).not.toContain(SAID);
      expect(batch.raw).not.toContain(ASKED);
    }
  });
});
