import { afterEach, describe, expect, it } from 'vitest';
import { koalaMetrics, withSpan } from './telemetry.js';
import { envSink, NEVER_MS, OTLP_ENDPOINT_VAR, otlpHttpSink, startTelemetry, type Telemetry, type TelemetrySettings } from './telemetry-sdk.js';
import { collector, freePort, type Collector, type Received } from '../testing/collector.js';

interface Attribute { key: string; value: { stringValue?: string } }
interface ResourceOf { resource: { attributes: Attribute[] } }

const collectors: Collector[] = [];
let telemetry: Telemetry | undefined;

const collecting = async (options: Parameters<typeof collector>[0] = {}): Promise<Collector> => {
  const started = await collector(options);
  collectors.push(started);
  return started;
};

const started = (settings: Omit<TelemetrySettings, 'spanDelayMs' | 'metricsEveryMs'>): Telemetry => {
  telemetry = startTelemetry({ ...settings, spanDelayMs: NEVER_MS, metricsEveryMs: NEVER_MS });
  return telemetry;
};

afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
  for (const stopping of collectors.splice(0)) await stopping.stop();
});

const at = (received: Received[], path: string) => received.filter((batch) => batch.path === path);

const spanNames = (received: Received[]): string[] => at(received, '/v1/traces')
  .flatMap((batch) => (batch.body as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] }).resourceSpans)
  .flatMap((resource) => resource.scopeSpans)
  .flatMap((scope) => scope.spans.map((span) => span.name));

const metricNames = (received: Received[]): string[] => at(received, '/v1/metrics')
  .flatMap((batch) => (batch.body as { resourceMetrics: { scopeMetrics: { metrics: { name: string }[] }[] }[] }).resourceMetrics)
  .flatMap((resource) => resource.scopeMetrics)
  .flatMap((scope) => scope.metrics.map((metric) => metric.name));

const resourceOf = (batch: Received | undefined): Record<string, string | undefined> => {
  const [first] = (batch?.body as { resourceSpans?: ResourceOf[]; resourceMetrics?: ResourceOf[] }).resourceSpans
    ?? (batch?.body as { resourceMetrics: ResourceOf[] }).resourceMetrics;
  return Object.fromEntries((first?.resource.attributes ?? []).map((attribute) => [attribute.key, attribute.value.stringValue]));
};

describe('telemetry sent to a collector over HTTP', () => {
  it('posts spans and metrics as OTLP JSON, under the service, version and role that sent them', async () => {
    const otel = await collecting();
    const sending = started({ service: 'koala-integration', version: 'v-test', role: 'instance', sink: otlpHttpSink(() => otel.url), log: () => undefined });

    await withSpan('tool.call', { 'koala.tool': 'read_file' }, async () => 'read');
    koalaMetrics().toolCallSeconds.record(0.2, { tool: 'read_file', outcome: 'ok' });
    await sending.flush();

    expect(otel.received.map((batch) => [batch.path, batch.contentType])).toEqual(expect.arrayContaining([
      ['/v1/traces', 'application/json'],
      ['/v1/metrics', 'application/json'],
    ]));
    expect(spanNames(otel.received)).toEqual(['tool.call']);
    expect(metricNames(otel.received)).toEqual(expect.arrayContaining(['koala_up', 'koala_tool_call_seconds']));
    expect(resourceOf(at(otel.received, '/v1/traces')[0])).toMatchObject({ 'service.name': 'koala-integration', 'service.version': 'v-test', 'koala.role': 'instance' });
    expect(resourceOf(at(otel.received, '/v1/metrics')[0])).toMatchObject({ 'service.name': 'koala-integration' });
  });

  it('reaches the collector named in the environment', async () => {
    const otel = await collecting();
    const sending = started({ service: 'koala-integration', sink: envSink({ [OTLP_ENDPOINT_VAR]: `${otel.url}/` }), log: () => undefined });

    await withSpan('model.call', {}, async () => 'answered');
    await sending.flush();

    expect(spanNames(otel.received)).toEqual(['model.call']);
  });

  it('drops what a collector that is not there would get, says so once, and says so again when it answers', async () => {
    const port = await freePort();
    const otel = await collecting({ port, listening: false });
    const said: string[] = [];
    const sending = started({ service: 'koala-integration', sink: otlpHttpSink(() => otel.url), log: (line) => said.push(line) });

    await withSpan('before', {}, async () => 'lost');
    await sending.flush();
    await withSpan('still before', {}, async () => 'lost');
    await sending.flush();
    await otel.start();
    await withSpan('after', {}, async () => 'kept');
    await sending.flush();

    expect(said).toEqual([
      expect.stringMatching(/^telemetry: traces are not reaching the collector \(fetch failed\); dropping them until it answers$/),
      expect.stringMatching(/^telemetry: metrics are not reaching the collector \(fetch failed\); dropping them until it answers$/),
      'telemetry: traces reach the collector again',
      'telemetry: metrics reach the collector again',
    ]);
    expect(spanNames(otel.received)).toEqual(['after']);
  });

  it('counts a collector that answers with an error as not reached', async () => {
    const otel = await collecting();
    otel.answerWith(503);
    const said: string[] = [];
    const sending = started({ service: 'koala-integration', sink: otlpHttpSink(() => otel.url), log: (line) => said.push(line) });

    await withSpan('refused', {}, async () => 'lost');
    await sending.flush();

    expect(said).toContain('telemetry: traces are not reaching the collector (the collector answered 503); dropping them until it answers');
    expect(otel.received).toEqual([]);
  });
});
