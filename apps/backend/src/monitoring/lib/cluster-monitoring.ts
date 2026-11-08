import type { Reach } from '../../infrastructure/index.js';

export const PROBE_RESOURCE = 'probes.monitoring.coreos.com';

export type MonitoringStackPart = 'cluster' | 'observability';

export interface MonitoringSeen {
  apiResources: string;
  blackbox: boolean;
  ingressClasses: string;
  telemetry?: TelemetrySeen | undefined;
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
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

export const placedOnPool = (env: NodeJS.ProcessEnv, reach: Pick<Reach, 'kind'>): boolean => env.POOL === 'true' && reach.kind === 'koala';

export interface KoalaClusterMonitoring {
  physicalName: string;
  reach: Reach;
  pool: boolean;
  koala: true;
}

export const koalaClusterMonitoring = (env: NodeJS.ProcessEnv, reach: Reach): KoalaClusterMonitoring => ({
  physicalName: reach.clusterId,
  reach,
  pool: placedOnPool(env, reach),
  koala: true,
});

export const appServiceType = (onPool: boolean): 'ClusterIP' | 'NodePort' => (onPool ? 'ClusterIP' : 'NodePort');

export function monitoringPlan(seen: MonitoringSeen, pool = false, machine = false): MonitoringPlan {
  const operator = lines(seen.apiResources).includes(PROBE_RESOURCE);
  const keepIngress = lines(seen.ingressClasses).length > 0;
  if (pool) return { stacks: operator && keepIngress ? [] : ['cluster'], keepIngress };
  if (machine) return { stacks: operator && seen.blackbox ? [] : ['cluster'], keepIngress };
  const stacks: MonitoringStackPart[] = [];
  if (!operator) stacks.push('cluster');
  if (!operator || !seen.blackbox || !telemetryPresent(seen.telemetry)) stacks.push('observability');
  return { stacks, keepIngress: lines(seen.ingressClasses).length > 0 };
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

export function monitoringStackName(physicalName: string, part: MonitoringStackPart): string {
  return part === 'cluster' ? physicalName : `${physicalName}-observability`;
}

export const METRICS_TOKEN_SECRET = 'koala-metrics';

export const machineMetricsUrl = (env: NodeJS.ProcessEnv): string =>
  env.MACHINE_METRICS_URL || `${(env.PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, '')}/api/machines/metrics`;

export function metricsTokenManifests(token: string): Array<Record<string, unknown>> {
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'monitoring' } },
    { apiVersion: 'v1', kind: 'Secret', metadata: { name: METRICS_TOKEN_SECRET, namespace: 'monitoring' }, type: 'Opaque', stringData: { token } },
  ];
}
