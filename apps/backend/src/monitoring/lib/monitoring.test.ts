import { describe, expect, it } from 'vitest';
import { appQuery, appChartQuery, KOALA_QUESTIONS, koalaQuery, koalaServicesQuery, stepFor, trafficSelector } from './monitoring-questions.js';
import { appLines, appVerdict, clusterVerdict, koalaLines, koalaVerdict, worstFirst } from './monitoring-summary.js';
import { alertExpression, alertRuleManifest, alertSpec, alertSummary, koalaAlertExpression, visibleAlerts, isKoalaAlertKind, KOALA_ALERT_KINDS, RULE_LABEL, type AlertRuleRecord, type AlertSpec } from './monitoring-alerts.js';
import { askQuery, parseAsk } from './monitoring-asks.js';
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

  it('counts no failures as none failing, not as unmeasured', () => {
    expect(appQuery('errorShare', books)).toMatch(/^\(sum\(rate\(.*code=~"5\.\."\}\[5m\]\)\) or vector\(0\)\) \/ sum/);
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

  it('reads as a sentence about the app, one minute or many', () => {
    expect(alertSummary('books', alertSpec('down', undefined, 1) as AlertSpec)).toBe('books has not answered for 1 minute');
    expect(alertSummary('books', alertSpec('volume', 85) as AlertSpec)).toBe('books has a volume over 85% full');
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

describe('the questions about Koala itself', () => {
  it('read only Koala\'s own metrics, one PromQL expression per question, and never on a pool place', () => {
    for (const question of KOALA_QUESTIONS) {
      expect(koalaQuery(question), question).toMatch(/koala_/);
      expect(askQuery({ kind: 'koala', question })).toBe(koalaQuery(question));
      expect(askQuery({ kind: 'koala', question }, { hostNamespace: 'pool-x' })).toBeUndefined();
    }
    expect(koalaQuery('requestErrorShare')).toMatch(/or vector\(0\)\) \/ sum/);
    expect(koalaQuery('reporting')).toBe('count(sum by (service_name) (koala_up))');
    expect(askQuery({ kind: 'koalaServices' })).toBe(koalaServicesQuery());
    expect(parseAsk({ kind: 'koala', question: 'modelQueued' })).toEqual({ kind: 'koala', question: 'modelQueued' });
    expect(parseAsk({ kind: 'koala', question: 'secrets' })).toBeUndefined();
    expect(parseAsk({ kind: 'koalaServices' })).toEqual({ kind: 'koalaServices' });
  });

  it('judges Koala down when nothing reports, and says what fails', () => {
    expect(koalaVerdict({}, [])).toEqual({ state: 'down', reasons: ['no part of Koala is reporting'] });
    expect(koalaVerdict({ requestsPerSecond: 1 }, ['koala-backend'])).toEqual({ state: 'ok', reasons: [] });
    expect(koalaVerdict({ requestErrorShare: 0.1, modelErrorShare: 0.5, workFailuresDay: 2 }, ['koala-backend']))
      .toEqual({ state: 'warning', reasons: ['10% of its requests fail', '50% of its model calls fail', '2 pieces of work failed in the last day'] });
  });

  it('says in plain lines what Koala serves, calls and failed, and what is not measured yet', () => {
    const numbers = { requestsPerSecond: 2.5, requestErrorShare: 0.01, requestSeconds: 0.25, modelCallsPerMinute: 3, modelErrorShare: 0, modelSeconds: 12, modelQueued: 2, workflowsStartedHour: 5, activityFailuresHour: 0, workFailuresDay: 1 };
    const services = ['koala-worker-engine', 'koala-backend'];
    expect(koalaLines(koalaVerdict(numbers, services), numbers, services)).toEqual([
      'Koala is needs attention: 1 piece of work failed in the last day.',
      '2 processes report: koala-backend, koala-worker-engine.',
      'It serves 2.5 requests a second, 1% of them failing, answering within 250 ms.',
      'Models: 3.0 calls a minute, 0% failing, answered within 12 s, 2 calls wait for a turn.',
      'Work: 5 workflows started in the last hour, 0 activities failed in the last hour, 1 piece of work failed in the last day.',
    ]);
    expect(koalaLines({ state: 'ok', reasons: [] }, {}, ['koala-backend'])).toEqual([
      'Koala is healthy.',
      '1 process reports: koala-backend.',
      'No requests have been measured yet.',
      'No model calls have been measured yet.',
    ]);
    expect(koalaLines({ state: 'installing', reasons: ['its collector is on its way'] }, {}, [])).toEqual(['Koala is getting its monitoring: its collector is on its way.']);
  });
});

describe('alerts about Koala itself', () => {
  it('are three templates on the same shape as the app ones, with their own expressions over Koala\'s metrics', () => {
    expect(KOALA_ALERT_KINDS).toEqual(['koala_down', 'model_errors', 'workflow_failures']);
    expect(isKoalaAlertKind('down')).toBe(false);
    const down = alertSpec('koala_down') as AlertSpec;
    expect(down).toEqual({ kind: 'koala_down', threshold: 0, forMinutes: 2 });
    expect(koalaAlertExpression(down)).toBe('absent(koala_up{service_name="koala-backend"})');
    expect(alertSummary('Koala', down)).toBe('Koala\'s backend has stopped reporting for 2 minutes');
    const errors = alertSpec('model_errors', 25) as AlertSpec;
    expect(koalaAlertExpression(errors)).toBe('(sum(rate(koala_model_call_seconds_count{outcome="failed"}[10m])) or vector(0)) / sum(rate(koala_model_call_seconds_count[10m])) > 0.25');
    expect(alertSpec('model_errors', 0)).toEqual({ error: 'the threshold for "model_errors" is in % of model calls failing, between 1 and 100' });
    const failures = alertSpec('workflow_failures') as AlertSpec;
    expect(koalaAlertExpression(failures)).toBe('sum(increase(koala_work_failures_total[1h])) > 3');
    expect(alertSummary('Koala', failures)).toBe('more than 3 pieces of Koala\'s work fail in an hour');
  });

  it('cannot be set on an app, and an app\'s alert cannot be set on Koala', () => {
    expect(alertExpression(alertSpec('koala_down') as AlertSpec, { namespace: 'books' })).toEqual({ error: 'koala_down is an alert about Koala itself; set it on "koala", not on an app' });
    expect(koalaAlertExpression(alertSpec('down') as AlertSpec)).toEqual({ error: 'down is an alert about an app, not about Koala itself' });
  });

  it('show as about Koala when their rule is one of Koala\'s own', () => {
    const alerts = [{ labels: { alertname: 'Koala_koala_down', [RULE_LABEL]: 'k1', namespace: 'monitoring' }, annotations: { summary: 'Koala\'s backend has stopped reporting for 2 minutes' }, state: 'firing' }];
    expect(visibleAlerts(alerts, { appsByNamespace: new Map(), ownRules: new Set(), koalaRules: new Set(['k1']), ownsCluster: true }))
      .toEqual([expect.objectContaining({ ruleId: 'k1', about: { kind: 'koala' }, summary: 'Koala\'s backend has stopped reporting for 2 minutes' })]);
    expect(visibleAlerts(alerts, { appsByNamespace: new Map(), ownRules: new Set(['k1']), ownsCluster: true })).toEqual([]);
  });
});
