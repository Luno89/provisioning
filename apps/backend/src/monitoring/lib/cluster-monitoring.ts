import type { Reach } from '../../infrastructure/index.js';
import { MONITORING_CHARTS } from './pool-monitoring.js';

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

export const placedOnPool = (pool: boolean, reach: Pick<Reach, 'kind'>): boolean => pool && reach.kind === 'koala';

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

export const appServiceType = (onPool: boolean): 'ClusterIP' | 'NodePort' => (onPool ? 'ClusterIP' : 'NodePort');

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

export function monitoringStackEnv(cluster: { physicalName: string; kubeconfigPath: string; pool?: boolean | undefined; machine?: { metricsUrl: string } | undefined; koala?: boolean | undefined }, keepIngress: boolean): Record<string, string> {
  return {
    STACK_TYPE: 'cluster',
    CLUSTER_NAME: cluster.physicalName,
    KUBECONFIG_PATH: cluster.kubeconfigPath,
    INGRESS_SERVICE: appServiceType(Boolean(cluster.pool)),
    ...(keepIngress ? { CLUSTER_INGRESS: 'existing' } : {}),
    ...(cluster.pool ? { CLUSTER_MONITORING: 'crds' } : {}),
    ...(cluster.machine ? { CLUSTER_MONITORING: 'agent', REMOTE_WRITE_URL: cluster.machine.metricsUrl } : {}),
    ...(cluster.koala ? { KOALA_CLUSTER: 'true' } : {}),
  };
}

export const INGRESS_NAMESPACE = 'traefik';

export function monitoringNamespaces(part: MonitoringStackPart, keepIngress: boolean): string[] {
  return part === 'cluster' && !keepIngress ? ['monitoring', INGRESS_NAMESPACE] : ['monitoring'];
}

export function monitoringStackName(physicalName: string, part: MonitoringStackPart): string {
  return part === 'cluster' ? physicalName : `${physicalName}-observability`;
}

export const METRICS_TOKEN_SECRET = 'koala-metrics';


export function metricsTokenManifests(token: string): Array<Record<string, unknown>> {
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'monitoring' } },
    { apiVersion: 'v1', kind: 'Secret', metadata: { name: METRICS_TOKEN_SECRET, namespace: 'monitoring' }, type: 'Opaque', stringData: { token } },
  ];
}
