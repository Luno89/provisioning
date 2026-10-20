import { describe, expect, it } from 'vitest';
import { askQuery, parseAsk, parseRange } from './monitoring-asks.js';
import { appQuery, usageQuery } from './monitoring-questions.js';

const pool = { hostNamespace: 'pool-alice' };

describe('a question asked of a cluster', () => {
  it('reads the same as before on a cluster of the person\'s own', () => {
    expect(askQuery({ kind: 'app', question: 'memoryBytes', subject: { namespace: 'shop' } }))
      .toBe('sum(container_memory_working_set_bytes{namespace="shop",container!="",container!="POD"})');
    expect(askQuery({ kind: 'usage', of: 'cpu' })).toBe('sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",image!=""}[5m]))');
    expect(askQuery({ kind: 'services', namespace: 'shop' })).toBe('kube_service_info{namespace="shop"}');
  });

  it('on Koala\'s servers reads only the instance\'s own namespace, finding the app\'s pods by the namespace they came from', () => {
    const memory = appQuery('memoryBytes', { namespace: 'shop' }, pool)!;
    expect(memory).toContain('container_memory_working_set_bytes{namespace="pool-alice"');
    expect(memory).toContain('kube_pod_labels{namespace="pool-alice",label_vcluster_loft_sh_namespace="shop"}');
    expect(appQuery('up', { namespace: 'shop' }, pool)).toBe('max(probe_success{namespace="pool-alice",koala_namespace="shop"})');
    expect(askQuery({ kind: 'cluster', question: 'memoryShare' }, pool)).toContain('kube_resourcequota{namespace="pool-alice",resource="requests.memory",type="hard"}');
    expect(usageQuery('memory', pool)).toContain('label_replace');
  });

  it('counts no requests there, and lists no services to count them by', () => {
    expect(appQuery('requestsPerSecond', { namespace: 'shop', services: ['web'] }, pool)).toBeUndefined();
    expect(askQuery({ kind: 'services', namespace: 'shop' }, pool)).toBeUndefined();
  });

  it('takes only questions it knows, about names that are names', () => {
    expect(parseAsk({ kind: 'app', question: 'up', subject: { namespace: 'shop' } })).toEqual({ kind: 'app', question: 'up', subject: { namespace: 'shop' } });
    expect(parseAsk({ kind: 'app', question: 'up', subject: { namespace: 'shop"} or vector(1) #' } })).toBeUndefined();
    expect(parseAsk({ kind: 'query', query: 'up' })).toBeUndefined();
    expect(parseAsk({ kind: 'app', question: 'everything', subject: { namespace: 'shop' } })).toBeUndefined();
    expect(parseAsk({ kind: 'window', question: 'uptime', subject: { namespace: 'shop' }, seconds: 1e12 })).toBeUndefined();
    expect(parseAsk({ kind: 'usage', of: 'memory' })).toEqual({ kind: 'usage', of: 'memory' });
  });

  it('takes a time range of sensible size', () => {
    expect(parseRange({ start: 0, end: 3600, step: 15 })).toEqual({ start: 0, end: 3600, step: 15 });
    expect(parseRange({ start: 0, end: 3600, step: 1 })).toBeUndefined();
    expect(parseRange({ start: 0, end: 30_000_000, step: 15 })).toBeUndefined();
  });
});
