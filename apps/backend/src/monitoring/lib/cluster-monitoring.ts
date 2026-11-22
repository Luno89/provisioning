import { METRICS_CLIENT_SECRET } from '@koala/engine-core/root-client';
import type { Reach } from '../../infrastructure/index.js';
import { appServiceType, placedOnPool } from '../../infrastructure/lib/cluster-places.js';

export const MONITORING_CHARTS = {
  namespace: 'monitoring',
  stack: { release: 'kube-prometheus-stack', chart: 'kube-prometheus-stack', version: '91.7.0' },
  blackbox: { release: 'blackbox-exporter', chart: 'prometheus-blackbox-exporter', version: '11.19.1' },
  repo: 'https://prometheus-community.github.io/helm-charts',
} as const;

export const PROBE_RESOURCE = 'probes.monitoring.coreos.com';

export type MonitoringStackPart = 'cluster' | 'observability';

export interface MonitoringSeen {
  apiResources: string;
  blackbox: boolean;
  ingressClasses: string;
  telemetry?: TelemetrySeen | undefined;
  charts?: Record<string, string> | undefined;
}

export interface TelemetrySeen {
  collector: boolean;
  tempo: boolean;
}

export const TELEMETRY_SERVICES = { collector: 'otel-collector', tempo: 'tempo' } as const;
export const COLLECTOR_OTLP_PORT = 4318;
export const COLLECTOR_METRICS_PORT = 8889;
export const TEMPO_PORT = 3200;

export const telemetryPresent = (seen: TelemetrySeen | undefined): boolean => Boolean(seen?.collector && seen.tempo);

export interface MonitoringPlan {
  stacks: MonitoringStackPart[];
  keepIngress: boolean;
  crdsFirst: boolean;
}

const elsewhere = (charts: Record<string, string> | undefined, part: { release: string; chart: string; version: string }): boolean => {
  const installed = charts?.[part.release];
  return installed !== undefined && installed !== `${part.chart}-${part.version}`;
};

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

export interface KoalaClusterMonitoring {
  physicalName: string;
  reach: Reach;
  pool: boolean;
  koala: true;
}

export const koalaClusterMonitoring = (pool: boolean, reach: Reach): KoalaClusterMonitoring => ({
  physicalName: reach.clusterId,
  reach,
  pool: placedOnPool(pool, reach),
  koala: true,
});

export function monitoringPlan(seen: MonitoringSeen, pool = false, machine = false): MonitoringPlan {
  const operator = lines(seen.apiResources).includes(PROBE_RESOURCE);
  const keepIngress = lines(seen.ingressClasses).length > 0;
  if (pool) return { stacks: operator && keepIngress ? [] : ['cluster'], keepIngress, crdsFirst: false };
  const stackBehind = elsewhere(seen.charts, MONITORING_CHARTS.stack);
  const blackboxBehind = elsewhere(seen.charts, MONITORING_CHARTS.blackbox);
  if (machine) return { stacks: operator && seen.blackbox && !stackBehind && !blackboxBehind ? [] : ['cluster'], keepIngress, crdsFirst: stackBehind };
  const stacks: MonitoringStackPart[] = [];
  if (!operator || stackBehind) stacks.push('cluster');
  if (!operator || !seen.blackbox || blackboxBehind || !telemetryPresent(seen.telemetry)) stacks.push('observability');
  return { stacks, keepIngress, crdsFirst: stackBehind };
}

export interface MetricsSending {
  url: string;
  tokenUrl: string;
  resource: string;
}

export const METRICS_SECRET_MISSING = (machine: string): string =>
  `${machine} holds no Secret ${METRICS_CLIENT_SECRET.name} in ${METRICS_CLIENT_SECRET.namespace}, which its Prometheus signs in to root with, so its monitoring is not applied: the machine's agent puts it there each time the cluster starts, so run the command from My Machines again`;

export function monitoringStackEnv(cluster: { physicalName: string; kubeconfigPath: string; pool?: boolean | undefined; machine?: MetricsSending | undefined; koala?: boolean | undefined }, keepIngress: boolean, existing: readonly string[]): Record<string, string> {
  return {
    STACK_TYPE: 'cluster',
    CLUSTER_NAME: cluster.physicalName,
    KUBECONFIG_PATH: cluster.kubeconfigPath,
    INGRESS_SERVICE: appServiceType(Boolean(cluster.pool)),
    ...(keepIngress ? { CLUSTER_INGRESS: 'existing' } : {}),
    ...(cluster.pool ? { CLUSTER_MONITORING: 'crds' } : {}),
    ...(cluster.machine ? { CLUSTER_MONITORING: 'agent', REMOTE_WRITE_URL: cluster.machine.url, METRICS_TOKEN_URL: cluster.machine.tokenUrl, METRICS_RESOURCE: cluster.machine.resource } : {}),
    ...(cluster.koala ? { KOALA_CLUSTER: 'true' } : {}),
    CLUSTER_EXISTING: JSON.stringify(existing),
  };
}

export const INGRESS_NAMESPACE = 'traefik';

export function monitoringNamespaces(part: MonitoringStackPart, keepIngress: boolean): string[] {
  return part === 'cluster' && !keepIngress ? ['monitoring', INGRESS_NAMESPACE] : ['monitoring'];
}

export function monitoringStackName(physicalName: string, part: MonitoringStackPart): string {
  return part === 'cluster' ? physicalName : `${physicalName}-observability`;
}

