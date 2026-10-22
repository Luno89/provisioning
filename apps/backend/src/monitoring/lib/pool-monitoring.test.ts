import { describe, expect, it } from 'vitest';
import {
  BLACKBOX_VALUES, hostProbeManifest, hostRuleManifest, parsePoolRule, parseProbes, placeAlerts, poolStackValues,
  probeIngressPolicy, probesFromCluster,
} from './pool-monitoring.js';

const place = { hostNamespace: 'pool-alice' };

describe('watching a pool instance\'s apps from root', () => {
  it('reads the probes the instance\'s apps made, keeping only ones aimed at their own namespace', () => {
    const json = JSON.stringify({ items: [
      { metadata: { namespace: 'shop' }, spec: { module: 'http_2xx', targets: { staticConfig: { static: ['web.shop.svc.cluster.local:8069/web/health'] } } } },
      { metadata: { namespace: 'shop' }, spec: { module: 'http_2xx', targets: { staticConfig: { static: ['db.other.svc.cluster.local:5432'] } } } },
      { metadata: { namespace: 'games' }, spec: { module: 'icmp', targets: { staticConfig: { static: ['srv.games.svc.cluster.local:1'] } } } },
    ] });
    expect(probesFromCluster(json)).toEqual([{ namespace: 'shop', service: 'web', port: 8069, path: '/web/health', module: 'http_2xx' }]);
  });

  it('probes the app\'s own service on the node, by the name it has there, labelled with its namespace inside', () => {
    const manifest = hostProbeManifest(place, { namespace: 'shop', service: 'web', port: 80, path: '', module: 'http_2xx' }, 'web-x-shop-x-alice') as any;
    expect(manifest.metadata.namespace).toBe('pool-alice');
    expect(manifest.spec.targets.staticConfig.static).toEqual(['web-x-shop-x-alice.pool-alice.svc.cluster.local:80']);
    expect(manifest.spec.targets.staticConfig.labels).toEqual({ koala_namespace: 'shop', app: 'web' });
  });

  it('refuses probes that are not an app\'s namespace, service, port, path and module', () => {
    expect(parseProbes([{ namespace: 'shop', service: 'web', port: 80, path: '/x', module: 'http_2xx' }])).toHaveLength(1);
    expect(parseProbes([{ namespace: 'shop', service: 'web', port: 80, path: '/x', module: 'http_post_2xx' }])).toBeUndefined();
    expect(parseProbes([{ namespace: 'shop', service: 'web', port: 80, path: '@evil.example/', module: 'http_2xx' }])).toBeUndefined();
    expect(parseProbes([{ namespace: 'shop', service: 'web.other', port: 80, path: '', module: 'http_2xx' }])).toBeUndefined();
  });

  it('builds an alert from its kind alone, in the instance\'s namespace, refusing what it cannot watch there', () => {
    const rule = parsePoolRule('r1', { namespace: 'shop', spec: { kind: 'down' }, summary: 'Shop has not answered for 5 minutes' });
    expect('error' in rule).toBe(false);
    const manifest = hostRuleManifest(place, rule as Exclude<typeof rule, { error: string }>) as any;
    expect(manifest.metadata.namespace).toBe('pool-alice');
    expect(manifest.spec.groups[0].rules[0].expr).toBe('max(probe_success{namespace="pool-alice",koala_namespace="shop"}) < 1');
    expect(manifest.spec.groups[0].rules[0].labels).toMatchObject({ koala_rule: 'r1', koala_namespace: 'shop' });
    expect(parsePoolRule('r2', { namespace: 'shop', spec: { kind: 'down', expr: 'up' }, summary: 's' })).not.toHaveProperty('expr');
    const errors = parsePoolRule('r3', { namespace: 'shop', spec: { kind: 'errors' }, summary: 's' });
    expect(hostRuleManifest(place, errors as Exclude<typeof errors, { error: string }>)).toEqual({ error: expect.stringContaining('not counted') });
    expect(parsePoolRule('r4', { namespace: 'shop', spec: { kind: 'slow', threshold: 9999 }, summary: 's' })).toEqual({ error: expect.stringContaining('between') });
  });

  it('shows an instance only its own alerts, under the namespaces it knows', () => {
    const alerts = placeAlerts([
      { state: 'firing', labels: { alertname: 'Koala_down', namespace: 'pool-alice', koala_namespace: 'shop', koala_rule: 'r1' } },
      { state: 'firing', labels: { alertname: 'KubePodCrashLooping', namespace: 'pool-alice', pod: 'web-x-shop-x-alice' } },
      { state: 'firing', labels: { alertname: 'KubePodCrashLooping', namespace: 'pool-bob', pod: 'web-x-shop-x-bob' } },
      { state: 'firing', labels: { alertname: 'NodeMemoryHighUtilization', instance: 'node' } },
      { state: 'firing', labels: { alertname: 'KubePodNotReady', namespace: 'pool-alice', pod: 'alice-0' } },
    ], place, new Map([['web-x-shop-x-alice', 'shop']]));
    expect(alerts.map((alert) => [alert.labels.alertname, alert.labels.namespace])).toEqual([['Koala_down', 'shop'], ['KubePodCrashLooping', 'shop']]);
    expect(alerts[0]!.labels).not.toHaveProperty('koala_namespace');
  });

  it('keeps every rule and probe on the node to the namespace it was made in, and never follows a redirect', () => {
    const values = poolStackValues() as any;
    expect(values.prometheus.prometheusSpec.enforcedNamespaceLabel).toBe('namespace');
    expect(values.prometheus.prometheusSpec.excludedFromEnforcement.every((ref: { namespace: string }) => ref.namespace === 'monitoring')).toBe(true);
    expect(values.grafana.enabled).toBe(false);
    expect(BLACKBOX_VALUES).toContain('follow_redirects: false');
    expect(BLACKBOX_VALUES).not.toContain('follow_redirects: true');
  });

  it('lets only the checker in, and only to the instance\'s own workloads', () => {
    const policy = probeIngressPolicy('alice', place) as any;
    expect(policy.metadata.namespace).toBe('pool-alice');
    expect(policy.spec.podSelector.matchLabels).toEqual({ 'vcluster.loft.sh/managed-by': 'alice' });
    expect(policy.spec.ingress[0].from[0].podSelector.matchLabels).toEqual({ 'app.kubernetes.io/name': 'prometheus-blackbox-exporter' });
  });
});
