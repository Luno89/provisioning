export const DEFAULT_HISTORY_DAYS = 10;
export const MIN_HISTORY_DAYS = 1;
export const MAX_HISTORY_DAYS = 365;

const GIB_PER_DAY = 0.5;
const MIN_STORAGE_GIB = 5;

export const PROMETHEUS_CHART = 'kube-prometheus-stack';
export const PROMETHEUS_CHART_REPO = 'https://prometheus-community.github.io/helm-charts';

export function historyProblem(days: unknown): string | undefined {
  if (typeof days !== 'number' || !Number.isInteger(days)) return 'days is a whole number';
  if (days < MIN_HISTORY_DAYS || days > MAX_HISTORY_DAYS) return `days is from ${MIN_HISTORY_DAYS} to ${MAX_HISTORY_DAYS}`;
  return undefined;
}

export interface PrometheusStorage {
  retention: string;
  retentionSize: string;
  storageGiB: number;
}

export function storageFor(days: number): PrometheusStorage {
  const storageGiB = Math.max(MIN_STORAGE_GIB, Math.ceil(days * GIB_PER_DAY * 1.25));
  return { retention: `${days}d`, retentionSize: `${Math.floor(storageGiB * 0.85)}GB`, storageGiB };
}

export interface PrometheusNow {
  retention?: string | undefined;
  retentionSize?: string | undefined;
  durable: boolean;
}

export function prometheusNow(resource: { spec?: { retention?: string; retentionSize?: string; storage?: { volumeClaimTemplate?: unknown } } }): PrometheusNow {
  return {
    retention: resource.spec?.retention,
    retentionSize: resource.spec?.retentionSize,
    durable: Boolean(resource.spec?.storage?.volumeClaimTemplate),
  };
}

export function historyApplied(now: PrometheusNow, days: number): boolean {
  const wanted = storageFor(days);
  return now.durable && now.retention === wanted.retention && now.retentionSize === wanted.retentionSize;
}

export const keptDays = (retention: string | undefined): number | undefined => {
  const match = retention?.match(/^(\d+)d$/);
  return match ? Number(match[1]) : undefined;
};

export function helmHistoryArgs(days: number, chartVersion: string): string[] {
  const storage = storageFor(days);
  return [
    'upgrade', PROMETHEUS_CHART, PROMETHEUS_CHART, '--repo', PROMETHEUS_CHART_REPO, '--version', chartVersion,
    '-n', 'monitoring', '--reuse-values',
    '--set', `prometheus.prometheusSpec.retention=${storage.retention}`,
    '--set', `prometheus.prometheusSpec.retentionSize=${storage.retentionSize}`,
    '--set', 'prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.accessModes[0]=ReadWriteOnce',
    '--set', `prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=${storage.storageGiB}Gi`,
  ];
}

export function chartVersionOf(releases: Array<{ name?: string; chart?: string }>): string | undefined {
  const chart = releases.find((release) => release.name === PROMETHEUS_CHART)?.chart;
  return chart?.startsWith(`${PROMETHEUS_CHART}-`) ? chart.slice(PROMETHEUS_CHART.length + 1) : undefined;
}
