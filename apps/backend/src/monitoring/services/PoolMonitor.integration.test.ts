import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { hashCredential, InstanceService } from '../../instances/services/InstanceService.js';
import { PoolMonitoringService } from '../../instances/services/PoolMonitoringService.js';
import { instancesRouter } from '../../instances/routes/instances.js';
import { alertSpec, type AlertSpec } from '../lib/monitoring-alerts.js';
import { poolMonitor } from './PoolMonitor.js';

const vector = (...values: number[]) => JSON.stringify({ status: 'success', data: { resultType: 'vector', result: values.map((value) => ({ metric: {}, value: [1, String(value)] })) } });

let harness: Harness;
let asked: string[];
let applied: string[];

const kubectl = async (args: string[]): Promise<string> => {
  const line = decodeURIComponent(args.join(' '));
  asked.push(line);
  if (line.includes('api/v1/alerts')) {
    return JSON.stringify({ status: 'success', data: { alerts: [
      { labels: { alertname: 'AppDown', namespace: 'pool-alice', koala_namespace: 'shop' }, state: 'firing', activeAt: '2026-11-02T00:00:00Z', value: '1' },
      { labels: { alertname: 'Other', namespace: 'pool-bob', koala_namespace: 'theirs' }, state: 'firing' },
    ] } });
  }
  if (line.includes('query_range')) return JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [{ metric: {}, values: [[100, '1'], [160, '2']] }] } });
  if (line.includes('api/v1/query')) return vector(1);
  if (line.startsWith('get services')) {
    return JSON.stringify({ items: [{ metadata: { name: 'shop-x-shop', labels: { 'vcluster.loft.sh/namespace': 'shop' }, annotations: { 'vcluster.loft.sh/object-namespace': 'shop', 'vcluster.loft.sh/object-name': 'web' } } }] });
  }
  return '';
};

beforeAll(async () => {
  asked = [];
  applied = [];
  harness = await mountRouter({
    prefix: '/api/instances',
    user: TEST_USER,
    router: async (db) => {
      await db.instances.saveInstance({
        id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('secret'),
        pool: { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: 'then', trialEndsAt: '2026-11-03T00:00:00.000Z' },
      } as never);
      return instancesRouter({
        instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', domain: 'koala.dev', pool: { slots: 1, trialDays: 14 } }, undefined),
        chart: async () => '',
        operatorOnly: (_req: Request, res: Response, _next: NextFunction) => { res.status(403).end(); },
        poolMonitoring: new PoolMonitoringService({ kubectl, apply: async (manifest) => { applied.push(manifest); } }),
      });
    },
  });
});

afterAll(async () => { await harness.close(); });

const monitor = (token = 'secret') => poolMonitor({ rootUrl: harness.url(''), instanceId: 'inst-1', token: async () => token });

describe('a pool instance\'s monitoring, answered by root over HTTP', () => {
  it('sends root a named question with its service token and reads the samples and points it answers', async () => {
    expect(await monitor().ask({ kind: 'app', question: 'up', subject: { namespace: 'shop' } })).toEqual([{ metric: {}, value: 1 }]);
    expect(asked.at(-1)).toContain('probe_success{namespace="pool-alice",koala_namespace="shop"}');
    expect(await monitor().askRange({ kind: 'app', question: 'up', subject: { namespace: 'shop' } }, { start: 100, end: 400, step: 60 })).toEqual([[100, 1], [160, 2]]);
  });

  it('reads the alerts of its own place only, how long history is kept, and sets and removes a rule and its probes', async () => {
    const alerts = await monitor().alerts();
    expect(alerts.map((alert) => [alert.labels.alertname, alert.labels.namespace])).toEqual([['AppDown', 'shop']]);
    expect(await monitor().history()).toEqual({ days: 10, kept: 10 });

    await monitor().setRule({ id: 'r1', namespace: 'shop', spec: alertSpec('down') as AlertSpec, summary: 'Shop is down' });
    expect(JSON.parse(applied.at(-1)!)).toMatchObject({ metadata: { namespace: 'pool-alice' } });
    await monitor().removeRule('r1');
    expect(asked.at(-1)).toContain('delete prometheusrule');

    await monitor().setProbes([{ namespace: 'shop', service: 'web', port: 80, path: '/', module: 'http_2xx' }]);
    expect(applied.length).toBe(2);
    expect(applied.at(-1)).toContain('pool-alice');
  });

  it('says why root refused: a credential it does not know, a question it does not answer, a rule it cannot write', async () => {
    await expect(monitor('wrong').alerts()).rejects.toThrow('root answered 401: unknown instance or credential');
    await expect(monitor().ask({ kind: 'query', query: 'up' } as never)).rejects.toThrow('root answered 400: that is not a question Koala answers');
    await expect(monitor().setRule({ id: 'r2', namespace: 'shop', spec: alertSpec('errors') as AlertSpec, summary: 's' })).rejects.toThrow(/root answered 400/);
  });
});
