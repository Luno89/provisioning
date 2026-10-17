import { describe, expect, it } from 'vitest';
import { appQuery, appChartQuery, stepFor, trafficSelector } from './monitoring-questions.js';
import { appLines, appVerdict, clusterVerdict, worstFirst } from './monitoring-summary.js';
import { alertExpression, alertRuleManifest, alertSpec, visibleAlerts, RULE_LABEL, type AlertRuleRecord, type AlertSpec } from './monitoring-alerts.js';
import { chartVersionOf, helmHistoryArgs, historyApplied, historyProblem, keptDays, prometheusNow, storageFor } from './monitoring-history.js';

const books = { namespace: 'books', services: ['audiobookshelf'] };

describe('the questions', () => {
  it('asks about one app by its namespace', () => {
    expect(appQuery('up', books)).toBe('max(probe_success{namespace="books"})');
  });

  it('counts an app\'s requests only through its own services', () => {
    expect(trafficSelector(books)).toBe('exported_service=~"books-(audiobookshelf)-[^@]+@kubernetes"');
    expect(appQuery('requestsPerSecond', { namespace: 'books' })).toBeUndefined();
  });

  it('cannot be broken out of a label by a namespace', () => {
    expect(appQuery('up', { namespace: 'a"}or vector(1)#' })).toBe('max(probe_success{namespace="a\\"}or vector(1)#"})');
  });

  it('charts memory as a share of the limit of running pods', () => {
    expect(appChartQuery('memoryShare', books)).toContain('/ (sum(kube_pod_container_resource_limits{namespace="books",resource="memory"}');
  });

  it('keeps charts to a few hundred points', () => {
    expect([stepFor('1h'), stepFor('24h'), stepFor('7d'), stepFor('30d')]).toEqual([15, 360, 2520, 10800]);
  });
});

describe('the verdicts', () => {
  it('calls an app that answers and has room healthy', () => {
    expect(appVerdict({ probed: 1, up: 1, memoryBytes: 100, memoryLimitBytes: 1000, restartsDay: 0 }, [])).toEqual({ state: 'ok', reasons: [] });
  });

  it('calls an app down when its probe fails', () => {
    expect(appVerdict({ probed: 1, up: 0 }, ['books is not answering'])).toEqual({ state: 'down', reasons: ['it does not answer', 'books is not answering'] });
  });

  it('judges an app with no probe by its containers', () => {
    expect(appVerdict({ probed: 0, podsRunning: 0 }, []).state).toBe('down');
    expect(appVerdict({ podsRunning: 2, podsBroken: 0 }, []).state).toBe('ok');
  });

  it('warns about memory near its limit, failing requests and restarts', () => {
    expect(appVerdict({ probed: 1, up: 1, memoryBytes: 95, memoryLimitBytes: 100, errorShare: 0.2, restartsDay: 2 }, [])).toEqual({
      state: 'warning',
      reasons: ['memory is at 95% of its limit', '20% of requests fail', 'it restarted 2 times in the last day'],
    });
  });

  it('calls a cluster down only when no machine is ready', () => {
    expect(clusterVerdict({ nodes: 2, nodesNotReady: 2 }, []).state).toBe('down');
    expect(clusterVerdict({ nodes: 2, nodesNotReady: 1, diskShare: 0.95 }, [])).toEqual({ state: 'warning', reasons: ['1 of 2 machines are not ready', 'the disk is 95% full'] });
  });

  it('puts the worst first', () => {
    const order = worstFirst([{ name: 'b', state: 'ok' as const }, { name: 'a', state: 'warning' as const }, { name: 'c', state: 'down' as const }]);
    expect(order.map((item) => item.name)).toEqual(['c', 'a', 'b']);
  });

  it('tells Koala what is not measured rather than leaving it out', () => {
    const lines = appLines('books', { state: 'ok', reasons: [] }, { podsRunning: 1 }, 10);
    expect(lines).toContain('It has no probe, so its uptime is not measured; it is judged by whether its containers run.');
    expect(lines).toContain('Its requests are not counted on this cluster yet.');
  });
});

describe('which alerts a person sees', () => {
  const scope = { appsByNamespace: new Map([['books', { deploymentId: 'd1', name: 'Books' }]]), ownRules: new Set(['r1']), ownsCluster: true };
  const firing = (labels: Record<string, string>, extra: Record<string, unknown> = {}) => ({ labels, state: 'firing', ...extra });

  it('shows their apps\' alerts in plain words', () => {
    expect(visibleAlerts([firing({ alertname: 'AppProbeDown', namespace: 'books' })], scope)).toEqual([
      { key: 'alertname=AppProbeDown,namespace=books', name: 'AppProbeDown', severity: 'warning', summary: 'Books is not answering', about: { kind: 'app', deploymentId: 'd1' } },
    ]);
  });

  it('never shows the always-firing or k3s noise, another app\'s alerts, or pending ones', () => {
    expect(visibleAlerts([
      firing({ alertname: 'Watchdog' }),
      firing({ alertname: 'KubeSchedulerDown' }),
      firing({ alertname: 'AppProbeDown', namespace: 'someone-else' }),
      { labels: { alertname: 'AppProbeDown', namespace: 'books' }, state: 'pending' },
    ], scope)).toEqual([]);
  });

  it('shows a rule only to the person who owns it', () => {
    const rule = firing({ alertname: 'Koala_down', namespace: 'books', [RULE_LABEL]: 'r1' }, { annotations: { summary: 'Books has not answered for 5 minutes' } });
    const other = firing({ alertname: 'Koala_down', namespace: 'books', [RULE_LABEL]: 'r2' });
    expect(visibleAlerts([rule, other], scope).map((alert) => [alert.summary, alert.ruleId])).toEqual([['Books has not answered for 5 minutes', 'r1']]);
  });

  it('shows machine alerts only to whoever owns the cluster', () => {
    const disk = firing({ alertname: 'NodeFilesystemAlmostOutOfSpace', instance: 'n1', mountpoint: '/' });
    expect(visibleAlerts([disk], scope)[0]?.about).toEqual({ kind: 'cluster' });
    expect(visibleAlerts([disk], { ...scope, ownsCluster: false })).toEqual([]);
  });
});

describe('alert rules', () => {
  it('fills in defaults and refuses thresholds out of range', () => {
    expect(alertSpec('down')).toEqual({ kind: 'down', threshold: 0, forMinutes: 5 });
    expect(alertSpec('memory', 150)).toEqual({ error: 'the threshold for "memory" is in % of its limit, between 10 and 100' });
    expect(alertSpec('slow', 1, 1.5)).toEqual({ error: 'forMinutes is whole minutes, from 0 to 1440' });
  });

  it('refuses to watch failing requests where none are counted', () => {
    expect(alertExpression({ kind: 'errors', threshold: 5, forMinutes: 10 }, { namespace: 'books' })).toEqual({ error: 'this app has no service whose requests are counted, so failing requests cannot be watched' });
  });

  it('becomes a PrometheusRule the operator picks up, labelled with its rule', () => {
    const spec = alertSpec('slow', 1.5) as AlertSpec;
    const rule: AlertRuleRecord = { id: 'R-1', ownerId: 'o', deploymentId: 'd1', clusterId: 'c', namespace: 'books', appName: 'Books', spec, summary: 'Books is slow', createdAt: 'now' };
    const manifest = alertRuleManifest(rule, alertExpression(spec, books) as string) as any;
    expect(manifest.metadata).toMatchObject({ name: 'koala-alert-r-1', namespace: 'books', labels: { release: 'kube-prometheus-stack' } });
    expect(manifest.spec.groups[0].rules[0]).toEqual({
      alert: 'Koala_slow',
      expr: 'avg(probe_duration_seconds{namespace="books"}) > 1.5',
      for: '10m',
      labels: { severity: 'warning', [RULE_LABEL]: 'R-1', namespace: 'books' },
      annotations: { summary: 'Books is slow' },
    });
  });
});

describe('history', () => {
  it('takes whole days within bounds', () => {
    expect(historyProblem(10)).toBeUndefined();
    expect(historyProblem(0)).toBe('days is from 1 to 365');
    expect(historyProblem(2.5)).toBe('days is a whole number');
  });

  it('sizes the volume from the days and caps the data below it', () => {
    expect(storageFor(10)).toEqual({ retention: '10d', retentionSize: '5GB', storageGiB: 7 });
    expect(storageFor(1)).toEqual({ retention: '1d', retentionSize: '4GB', storageGiB: 5 });
  });

  it('is applied only when Prometheus keeps it on a volume with that retention', () => {
    const emptyDir = prometheusNow({ spec: { retention: '10d' } });
    expect(historyApplied(emptyDir, 10)).toBe(false);
    const durable = prometheusNow({ spec: { retention: '10d', retentionSize: '5GB', storage: { volumeClaimTemplate: {} } } });
    expect(historyApplied(durable, 10)).toBe(true);
    expect(historyApplied(durable, 30)).toBe(false);
    expect(keptDays(durable.retention)).toBe(10);
  });

  it('upgrades the chart at the version it runs, keeping its other values', () => {
    expect(chartVersionOf([{ name: 'kube-prometheus-stack', chart: 'kube-prometheus-stack-79.1.0' }])).toBe('79.1.0');
    const args = helmHistoryArgs(30, '79.1.0');
    expect(args.slice(0, 11)).toEqual(['upgrade', 'kube-prometheus-stack', 'kube-prometheus-stack', '--repo', 'https://prometheus-community.github.io/helm-charts', '--version', '79.1.0', '-n', 'monitoring', '--reuse-values', '--set']);
    expect(args).toContain('prometheus.prometheusSpec.retention=30d');
  });
});
