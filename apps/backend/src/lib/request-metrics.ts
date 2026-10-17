export const TRAEFIK_CHART_REPO = 'https://traefik.github.io/charts';

export interface HelmRelease {
  name?: string;
  namespace?: string;
  chart?: string;
}

export type TraefikKind = { kind: 'ours'; version: string } | { kind: 'k3s' } | { kind: 'none' };

export function traefikOf(releases: readonly HelmRelease[]): TraefikKind {
  const ours = releases.find((release) => release.name === 'traefik' && release.namespace === 'traefik');
  if (ours?.chart?.startsWith('traefik-')) return { kind: 'ours', version: ours.chart.slice('traefik-'.length) };
  if (releases.some((release) => release.name === 'traefik' && release.namespace === 'kube-system')) return { kind: 'k3s' };
  return { kind: 'none' };
}

export const servicesLabelled = (values: { metrics?: { prometheus?: { addServicesLabels?: unknown } } } | null | undefined): boolean =>
  values?.metrics?.prometheus?.addServicesLabels === true;

export function ourTraefikArgs(version: string): string[] {
  return [
    'upgrade', 'traefik', 'traefik', '--repo', TRAEFIK_CHART_REPO, '--version', version, '-n', 'traefik', '--reuse-values',
    '--set', 'metrics.prometheus.addServicesLabels=true',
  ];
}

export const K3S_TRAEFIK_VALUES = [
  'metrics:',
  '  prometheus:',
  '    addServicesLabels: true',
  '    service:',
  '      enabled: true',
  '    serviceMonitor:',
  '      enabled: true',
  '      additionalLabels:',
  '        release: kube-prometheus-stack',
].join('\n');

export const K3S_TRAEFIK_CONFIG = {
  apiVersion: 'helm.cattle.io/v1',
  kind: 'HelmChartConfig',
  metadata: { name: 'traefik', namespace: 'kube-system', labels: { 'koala.dev/managed': 'request-metrics' } },
  spec: { valuesContent: K3S_TRAEFIK_VALUES },
};

export type K3sConfigState = 'missing' | 'ours' | 'theirs';

export function k3sConfigState(existing: { metadata?: { labels?: Record<string, string> }; spec?: { valuesContent?: string } } | undefined): K3sConfigState {
  if (!existing) return 'missing';
  if (existing.metadata?.labels?.['koala.dev/managed'] === 'request-metrics' && existing.spec?.valuesContent === K3S_TRAEFIK_VALUES) return 'ours';
  return existing.metadata?.labels?.['koala.dev/managed'] === 'request-metrics' ? 'missing' : 'theirs';
}
