import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { RequestHandler } from 'express';

export interface MetricsSettings {
  token?: string | undefined;
  role: string;
}

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
      res.on('finish', () => {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        this.requests.observe({ method: req.method, route: routeOf(req.path), status: String(res.statusCode) }, seconds);
      });
      next();
    };
  }

  failed(kind: string): void {
    this.failures.inc({ kind });
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
