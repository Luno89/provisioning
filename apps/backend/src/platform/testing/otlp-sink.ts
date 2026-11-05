import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type OtlpSignal = 'traces' | 'metrics';

export interface OtlpBatch { signal: OtlpSignal; raw: string; body: unknown }

export interface OtlpSpan { traceId: string; spanId: string; parentSpanId?: string | undefined; name: string; service: string; attributes: Record<string, unknown> }

export interface OtlpMetric { name: string; service: string; points: Record<string, unknown>[] }

export interface OtlpSink {
  url: string;
  received: OtlpBatch[];
  spans(): OtlpSpan[];
  metrics(): OtlpMetric[];
  close(): Promise<void>;
}

interface KeyValue { key: string; value: Record<string, unknown> }

interface Resourced { resource?: { attributes?: KeyValue[] } }

interface TraceBody { resourceSpans?: (Resourced & { scopeSpans?: { spans?: { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes?: KeyValue[] }[] }[] })[] }

interface Points { dataPoints?: { attributes?: KeyValue[] }[] }

interface MetricBody { resourceMetrics?: (Resourced & { scopeMetrics?: { metrics?: Record<string, unknown>[] }[] })[] }

const attributesOf = (list: KeyValue[] | undefined): Record<string, unknown> =>
  Object.fromEntries((list ?? []).map((entry) => [entry.key, Object.values(entry.value)[0]]));

const serviceOf = (resourced: Resourced): string => String(attributesOf(resourced.resource?.attributes)['service.name'] ?? '');

const pointsOf = (metric: Record<string, unknown>): Points | undefined =>
  Object.values(metric).find((value): value is Points => typeof value === 'object' && value !== null && 'dataPoints' in value);

const SIGNALS: Record<string, OtlpSignal> = { '/v1/traces': 'traces', '/v1/metrics': 'metrics' };

export async function otlpSink(): Promise<OtlpSink> {
  const received: OtlpBatch[] = [];
  const server = http.createServer((req, res) => {
    const signal = SIGNALS[req.url ?? ''];
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || !signal || req.headers['content-type'] !== 'application/json') {
        res.writeHead(415).end();
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({ signal, raw, body: JSON.parse(raw) as unknown });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  const bodies = <T>(signal: OtlpSignal): T[] => received.filter((batch) => batch.signal === signal).map((batch) => batch.body as T);
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    spans: () => bodies<TraceBody>('traces').flatMap((body) => (body.resourceSpans ?? []).flatMap((resourced) =>
      (resourced.scopeSpans ?? []).flatMap((scope) => (scope.spans ?? []).map((span) => ({
        traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId || undefined, name: span.name,
        service: serviceOf(resourced), attributes: attributesOf(span.attributes),
      }))))),
    metrics: () => bodies<MetricBody>('metrics').flatMap((body) => (body.resourceMetrics ?? []).flatMap((resourced) =>
      (resourced.scopeMetrics ?? []).flatMap((scope) => (scope.metrics ?? []).map((metric) => ({
        name: String(metric.name), service: serviceOf(resourced), points: (pointsOf(metric)?.dataPoints ?? []).map((point) => attributesOf(point.attributes)),
      }))))),
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
