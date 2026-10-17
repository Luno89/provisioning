import { describe, expect, it } from 'vitest';
import { K3S_TRAEFIK_CONFIG, k3sConfigState, ourTraefikArgs, servicesLabelled, traefikOf } from './request-metrics.js';

describe('counting each app\'s requests', () => {
  it('tells our Traefik from k3s\'s, at the version it runs', () => {
    expect(traefikOf([{ name: 'traefik', namespace: 'traefik', chart: 'traefik-41.4.0' }])).toEqual({ kind: 'ours', version: '41.4.0' });
    expect(traefikOf([{ name: 'traefik', namespace: 'kube-system', chart: 'traefik-34.2.1+up34.2.0' }])).toEqual({ kind: 'k3s' });
    expect(traefikOf([])).toEqual({ kind: 'none' });
  });

  it('switches service labels on in our Traefik, keeping its other values', () => {
    expect(servicesLabelled({ metrics: { prometheus: { addServicesLabels: true } } })).toBe(true);
    expect(servicesLabelled({ metrics: { prometheus: {} } })).toBe(false);
    expect(ourTraefikArgs('41.4.0')).toEqual(['upgrade', 'traefik', 'traefik', '--repo', 'https://traefik.github.io/charts', '--version', '41.4.0', '-n', 'traefik', '--reuse-values', '--set', 'metrics.prometheus.addServicesLabels=true']);
  });

  it('never overwrites a k3s Traefik configuration the person made', () => {
    expect(k3sConfigState(undefined)).toBe('missing');
    expect(k3sConfigState(K3S_TRAEFIK_CONFIG)).toBe('ours');
    expect(k3sConfigState({ metadata: { labels: {} }, spec: { valuesContent: 'ports: {}' } })).toBe('theirs');
    expect(k3sConfigState({ metadata: { labels: { 'koala.dev/managed': 'request-metrics' } }, spec: { valuesContent: 'old' } })).toBe('missing');
  });
});
