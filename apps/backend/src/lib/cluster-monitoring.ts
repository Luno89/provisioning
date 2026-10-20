export const PROBE_RESOURCE = 'probes.monitoring.coreos.com';

export type MonitoringStackPart = 'cluster' | 'observability';

export interface MonitoringSeen {
  apiResources: string;
  blackbox: boolean;
  ingressClasses: string;
}

export interface MonitoringPlan {
  stacks: MonitoringStackPart[];
  keepIngress: boolean;
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

export const SYSTEM_CLUSTER = 'provisioning-lunorica';

export const placedOnPool = (env: NodeJS.ProcessEnv, physicalName: string): boolean => env.POOL === 'true' && physicalName === SYSTEM_CLUSTER;

export const appServiceType = (onPool: boolean, selfManaged: boolean): 'ClusterIP' | 'NodePort' | 'LoadBalancer' =>
  (onPool ? 'ClusterIP' : selfManaged ? 'NodePort' : 'LoadBalancer');

export function monitoringPlan(seen: MonitoringSeen, pool = false): MonitoringPlan {
  const operator = lines(seen.apiResources).includes(PROBE_RESOURCE);
  const keepIngress = lines(seen.ingressClasses).length > 0;
  if (pool) return { stacks: operator && keepIngress ? [] : ['cluster'], keepIngress };
  const stacks: MonitoringStackPart[] = [];
  if (!operator) stacks.push('cluster');
  if (!operator || !seen.blackbox) stacks.push('observability');
  return { stacks, keepIngress: lines(seen.ingressClasses).length > 0 };
}

export function monitoringStackEnv(cluster: { physicalName: string; kubeconfigPath: string; local: boolean; pool?: boolean | undefined }, keepIngress: boolean): Record<string, string> {
  return {
    STACK_TYPE: 'cluster',
    ENV: cluster.local ? 'k3d' : 'remote',
    CLUSTER_NAME: cluster.physicalName,
    KUBECONFIG_PATH: cluster.kubeconfigPath,
    ...(keepIngress ? { CLUSTER_INGRESS: 'existing' } : {}),
    ...(cluster.pool ? { CLUSTER_MONITORING: 'crds', INGRESS_SERVICE: 'ClusterIP' } : {}),
  };
}

export function monitoringStackName(physicalName: string, part: MonitoringStackPart): string {
  return part === 'cluster' ? physicalName : `${physicalName}-observability`;
}
