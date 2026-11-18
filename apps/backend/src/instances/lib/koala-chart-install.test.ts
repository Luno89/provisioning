import { describe, expect, it } from 'vitest';
import { installArgsOf, valuesFilesIn } from './koala-chart-install.js';

describe('what putting Koala\'s chart on a cluster is asked for', () => {
  it('names the cluster\'s kubeconfig, the release, its namespace and the chart, and passes everything after -- to helm as values', () => {
    expect(installArgsOf(['--kubeconfig', '/k3s.yaml', '--release', 'instance', '--namespace', 'nowrinkles', '--chart', '/app/charts/instance', '--', '-f', '/values/values.json', '--set-string', 'dev.coverage=']))
      .toEqual({ kubeconfig: '/k3s.yaml', release: 'instance', namespace: 'nowrinkles', chart: '/app/charts/instance', values: ['-f', '/values/values.json', '--set-string', 'dev.coverage='] });
  });

  it('refuses a call that leaves out what it needs or names what it does not take, saying which', () => {
    expect(() => installArgsOf(['--release', 'instance', '--namespace', 'nowrinkles', '--chart', '/c'])).toThrow('--kubeconfig names the cluster\'s kubeconfig file');
    expect(() => installArgsOf(['--kubeconfig', '/k', '--release', 'instance', '--namespace', 'n', '--chart', '/c', '--wait'])).toThrow('--wait is not taken: helm values go after --');
    expect(() => installArgsOf(['--kubeconfig', '/k', '--release', 'instance', '--namespace', 'n', '--chart', '/c', '--', '--wait'])).toThrow('helm is never told to wait or given a time limit: Koala follows the rollout itself');
    expect(() => installArgsOf(['--kubeconfig', '/k', '--release', 'instance', '--namespace', 'n', '--chart', '/c', '--', '--timeout', '720h'])).toThrow('helm is never told to wait or given a time limit: Koala follows the rollout itself');
  });

  it('finds the values files among helm\'s arguments, so what they hold counts toward what the release is made from', () => {
    expect(valuesFilesIn(['-f', '/a.json', '--values', '/b.yaml', '--set-file', 'instance.rootPublicKeys=/keys.pem', '--set', 'x=1'])).toEqual(['/a.json', '/b.yaml', '/keys.pem']);
  });
});
