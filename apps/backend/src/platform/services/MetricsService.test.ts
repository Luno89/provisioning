import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { SpanStatusCode, trace, type Span, type Tracer, type TracerProvider } from '@opentelemetry/api';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { MetricsService, routeOf, TRACE_ID_HEADER } from './MetricsService.js';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const span = mock<Span>();
span.spanContext.mockReturnValue({ traceId: TRACE_ID, spanId: 'b7ad6b7169203331', traceFlags: 1 });

beforeAll(() => {
  const tracer = mock<Tracer>();
  tracer.startSpan.mockReturnValue(span);
  const provider = mock<TracerProvider>();
  provider.getTracer.mockReturnValue(tracer);
  trace.setGlobalTracerProvider(provider);
});

type Exchange = { req: Request; res: Response & EventEmitter; headers: Map<string, string>; ran: () => boolean };

function exchange(url: string, statusCode: number, method = 'GET'): Exchange {
  const headers = new Map<string, string>();
  const res = Object.assign(new EventEmitter(), {
    statusCode,
    setHeader: (name: string, value: string) => { headers.set(name, value); },
  }) as unknown as Response & EventEmitter;
  const req = { method, headers: {}, originalUrl: url, path: url.split('?')[0] } as unknown as Request;
  return { req, res, headers, ran: () => true };
}

describe('metrics about Koala itself', () => {
  it('groups request paths by route, not by id or token', () => {
    expect(routeOf('/api/projects/3fa85f64-5717-4562-b3fc-2c963f66afa6/releases/abc/files')).toBe('/api/projects/:id/releases');
    expect(routeOf('/api/hub/projects/0123456789abcdef01234567/board')).toBe('/api/hub/projects/:id');
    expect(routeOf('/api/share/aGVsbG8td29ybGQtaGVsbG8td29ybGQtMTIzNDU2Nzg')).toBe('/api/share/:token');
    expect(routeOf('/api/auth/login')).toBe('/api/auth/login');
  });

  it('serves its text only to the bearer of the metrics token, and counts failed work by kind', async () => {
    const metrics = new MetricsService({ token: 'secret', role: 'combined' });
    expect(metrics.allowed('Bearer secret')).toBe(true);
    expect(metrics.allowed('Bearer other')).toBe(false);
    expect(metrics.allowed(undefined)).toBe(false);
    expect(new MetricsService({ role: 'combined' }).allowed('Bearer anything')).toBe(false);
    metrics.failed('chat');
    metrics.failed('chat');
    const text = await metrics.text();
    expect(text).toContain('koala_work_failures_total{kind="chat",role="combined"} 2');
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(metrics.contentType).toMatch(/text\/plain/);
  });

  it('hands out one gauge per name, however often it is asked for', async () => {
    const metrics = new MetricsService({ role: 'root' });
    const first = metrics.gauge('koala_things', 'How many things', ['kind']);
    first.set({ kind: 'a' }, 3);
    expect(metrics.gauge('koala_things', 'ignored')).toBe(first);
    expect(await metrics.text()).toContain('koala_things{kind="a",role="root"} 3');
  });

  it('answers the trace id of a request and times it by its whole path once it finishes', async () => {
    const metrics = new MetricsService({ role: 'combined' });
    const { req, res, headers } = exchange('/api/evals/level2/runs?x=1', 200, 'POST');
    const next = vi.fn();
    metrics.middleware()(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(headers.get(TRACE_ID_HEADER)).toBe(TRACE_ID);
    res.emit('finish');
    const text = await metrics.text();
    expect(text).toContain('koala_http_request_seconds_count{role="combined",method="POST",route="/api/evals/level2/runs",status="200"} 1');
    expect(span.updateName).toHaveBeenCalledWith('POST /api/evals/level2/runs');
    expect(span.end).toHaveBeenCalled();
  });

  it('counts a request once even when the connection closes after it finished', async () => {
    const metrics = new MetricsService({ role: 'combined' });
    const { req, res } = exchange('/api/things', 204);
    metrics.middleware()(req, res, vi.fn());
    res.emit('finish');
    res.emit('close');
    expect(await metrics.text()).toContain('koala_http_request_seconds_count{role="combined",method="GET",route="/api/things",status="204"} 1');
  });

  it('marks the trace of a request that failed on the server as an error, and not one that was refused', () => {
    const metrics = new MetricsService({ role: 'combined' });
    span.setStatus.mockClear();
    const refused = exchange('/api/things', 404);
    metrics.middleware()(refused.req, refused.res, vi.fn());
    refused.res.emit('close');
    expect(span.setStatus).not.toHaveBeenCalled();
    const broken = exchange('/api/things', 503);
    metrics.middleware()(broken.req, broken.res, vi.fn());
    broken.res.emit('close');
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });
});
