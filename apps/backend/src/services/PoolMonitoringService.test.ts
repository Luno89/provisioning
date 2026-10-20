import { describe, expect, it } from 'vitest';
import { PoolMonitoringService } from './PoolMonitoringService.js';

const place = { hostNamespace: 'pool-alice' };

const answer = (result: unknown[]) => JSON.stringify({ status: 'success', data: { resultType: 'vector', result } });

describe('root watching one pool instance', () => {
  it('probes the services the instance has, under their names on the node, and removes probes it no longer wants', async () => {
    const calls: string[][] = [];
    const applied: string[] = [];
    const monitoring = new PoolMonitoringService({
      kubectl: async (args) => {
        calls.push(args);
        if (args[1] === 'services') {
          return JSON.stringify({ items: [{ metadata: { name: 'web-x-shop-x-alice', labels: { 'vcluster.loft.sh/namespace': 'shop' }, annotations: { 'vcluster.loft.sh/object-namespace': 'shop', 'vcluster.loft.sh/object-name': 'web' } } }] });
        }
        if (args[1] === 'probes.monitoring.coreos.com' && args[0] === 'get') return 'probe.monitoring.coreos.com/koala-probe-old\n';
        return '';
      },
      apply: async (manifest) => { applied.push(manifest); },
    });
    const outcome = await monitoring.setProbes('alice', place, [
      { namespace: 'shop', service: 'web', port: 80, path: '', module: 'http_2xx' },
      { namespace: 'shop', service: 'gone', port: 80, path: '', module: 'http_2xx' },
    ]);
    expect(outcome).toEqual({ probed: 1, missing: ['shop/gone'] });
    expect(calls[0]).toEqual(['get', 'services', '-n', 'pool-alice', '-l', 'vcluster.loft.sh/managed-by=alice', '-o', 'json']);
    expect(JSON.parse(applied[0]!).spec.targets.staticConfig.static).toEqual(['web-x-shop-x-alice.pool-alice.svc.cluster.local:80']);
    expect(calls.at(-1)).toEqual(['delete', 'probes.monitoring.coreos.com', '-n', 'pool-alice', '--ignore-not-found', 'koala-probe-old']);
  });

  it('tells an instance the use of its own pods only', async () => {
    const monitoring = new PoolMonitoringService({
      kubectl: async () => answer([
        { metric: { namespace: 'shop', pod: 'web-1' }, value: [1, '100'] },
        { metric: { namespace: 'pool-alice', pod: 'alice-0' }, value: [1, '900'] },
      ]),
      apply: async () => {},
    });
    expect(await monitoring.ask(place, { kind: 'usage', of: 'memory' })).toEqual([{ metric: { namespace: 'shop', pod: 'web-1' }, value: 100 }]);
  });

  it('reads alerts through the API server and shows only the instance\'s own', async () => {
    const monitoring = new PoolMonitoringService({
      kubectl: async (args) => {
        const url = decodeURIComponent(args[2] ?? '');
        if (url.endsWith('/alerts')) {
          return JSON.stringify({ status: 'success', data: { alerts: [
            { state: 'firing', labels: { alertname: 'KubePodCrashLooping', namespace: 'pool-alice', pod: 'web-x-shop-x-alice' } },
            { state: 'firing', labels: { alertname: 'KubePodCrashLooping', namespace: 'pool-bob', pod: 'web-x-shop-x-bob' } },
          ] } });
        }
        return answer([{ metric: { pod: 'web-x-shop-x-alice', label_vcluster_loft_sh_namespace: 'shop' }, value: [1, '1'] }]);
      },
      apply: async () => {},
    });
    expect((await monitoring.alerts(place)).map((alert) => alert.labels)).toEqual([{ alertname: 'KubePodCrashLooping', namespace: 'shop', pod: 'web-x-shop-x-alice' }]);
  });
});
