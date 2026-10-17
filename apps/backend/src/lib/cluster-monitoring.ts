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

export function monitoringPlan(seen: MonitoringSeen): MonitoringPlan {
  const operator = lines(seen.apiResources).includes(PROBE_RESOURCE);
  const stacks: MonitoringStackPart[] = [];
  if (!operator) stacks.push('cluster');
  if (!operator || !seen.blackbox) stacks.push('observability');
  return { stacks, keepIngress: lines(seen.ingressClasses).length > 0 };
}

export function monitoringStackEnv(cluster: { physicalName: string; kubeconfigPath: string; local: boolean }, keepIngress: boolean): Record<string, string> {
  return {
    STACK_TYPE: 'cluster',
    ENV: cluster.local ? 'k3d' : 'remote',
    CLUSTER_NAME: cluster.physicalName,
    KUBECONFIG_PATH: cluster.kubeconfigPath,
    ...(keepIngress ? { CLUSTER_INGRESS: 'existing' } : {}),
  };
}

export function monitoringStackName(physicalName: string, part: MonitoringStackPart): string {
  return part === 'cluster' ? physicalName : `${physicalName}-observability`;
}
