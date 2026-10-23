import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { RequestHandler } from 'express';
import { context, isValidTraceId, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { koalaMetrics, koalaTracer } from '@koala/engine-core/telemetry';

export interface MetricsSettings {
  token?: string | undefined;
  role: string;
}

export const TRACE_ID_HEADER = 'x-trace-id';

const routeOf = (path: string): string => path
  .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
  .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id')
  .replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, '/:token')
  .split('/').slice(0, 5).join('/');

export class MetricsService {
  readonly registry = new Registry();
  private readonly requests: Histogram<string>;
  private readonly failures: Counter<string>;
  private readonly gauges = new Map<string, Gauge<string>>();

  constructor(private readonly settings: MetricsSettings) {
    this.registry.setDefaultLabels({ role: settings.role });
    collectDefaultMetrics({ register: this.registry });
    this.requests = new Histogram({
      name: 'koala_http_request_seconds',
      help: 'How long each API request took, by route and status',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.3, 1, 3, 10, 30],
      registers: [this.registry],
    });
    this.failures = new Counter({
      name: 'koala_work_failures_total',
      help: 'Top-level work that ended failed, by kind',
      labelNames: ['kind'],
      registers: [this.registry],
    });
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      const span = koalaTracer().startSpan('http.request', { kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method } }, propagation.extract(context.active(), req.headers));
      const traceId = span.spanContext().traceId;
      if (isValidTraceId(traceId)) res.setHeader(TRACE_ID_HEADER, traceId);
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const route = routeOf(req.originalUrl.split('?')[0] ?? req.path);
        const status = String(res.statusCode);
        this.requests.observe({ method: req.method, route, status }, seconds);
        koalaMetrics().httpRequestSeconds.record(seconds, { method: req.method, route, status });
        span.updateName(`${req.method} ${route}`);
        span.setAttributes({ 'http.route': route, 'http.response.status_code': res.statusCode });
        if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      };
      res.once('finish', end);
      res.once('close', end);
      context.with(trace.setSpan(context.active(), span), next);
    };
  }

  failed(kind: string): void {
    this.failures.inc({ kind });
    koalaMetrics().workFailures.add(1, { kind });
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
    let gauge = this.gauges.get(name);
    if (!gauge) {
      gauge = new Gauge({ name, help, labelNames, registers: [this.registry] });
      this.gauges.set(name, gauge);
    }
    return gauge;
  }

  allowed(authorization: string | undefined): boolean {
    if (!this.settings.token) return false;
    return authorization === `Bearer ${this.settings.token}`;
  }

  async text(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}

export { routeOf };
