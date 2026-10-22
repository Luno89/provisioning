import { describe, expect, it } from 'vitest';
import { MetricsService, routeOf } from './MetricsService.js';

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
    expect(new MetricsService({ role: 'combined' }).allowed('Bearer anything')).toBe(false);
    metrics.failed('chat');
    metrics.failed('chat');
    const text = await metrics.text();
    expect(text).toContain('koala_work_failures_total{kind="chat",role="combined"} 2');
    expect(text).toContain('process_cpu_user_seconds_total');
  });
});
