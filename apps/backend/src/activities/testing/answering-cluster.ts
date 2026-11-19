import { mock, type MockProxy } from 'vitest-mock-extended';
import type { ClusterAccess, InfisicalService, InfrastructureService, Provisioner, Reach } from '../../infrastructure/index.js';
import type { GiteaService } from '../../projects/index.js';

export function stepsOn(access: MockProxy<ClusterAccess>, infra: MockProxy<InfrastructureService>, dataKey: string) {
  return {
    access, infra, gitea: mock<GiteaService>(), infisical: mock<InfisicalService>(),
    database: { mongo: { uri: 'mongodb://unused', dbName: 'unused' }, dataKey },
    machineMetricsUrl: 'http://100.64.0.7:30320/api/machines/metrics',
    provisioner: mock<Provisioner>(),
  };
}

export interface AnsweringCluster {
  reached?: (target: Reach) => void;
  nodes?: () => string;
}

export function answerAsACluster(access: MockProxy<ClusterAccess>, cluster: AnsweringCluster = {}): void {
  const reach = (target: unknown) => cluster.reached?.(target as Reach);
  Object.defineProperty(access, 'here', { value: { root: false, koalaMachineId: 'koala' }, configurable: true });
  access.kubeconfigOf.mockImplementation(async (target) => `/clusters/kubeconfig-${(target as Reach).clusterId}`);
  access.apply.mockImplementation(async (target) => { reach(target); return ''; });
  access.helm.mockImplementation(async (target, args) => { reach(target); return args[0] === 'list' ? '[]' : ''; });
  access.kubectl.mockImplementation(async (target, args) => {
    reach(target);
    if (args[0] === 'api-resources') return 'probes.monitoring.coreos.com\n';
    if (args[0] === 'get' && args[1] === 'service') return `service/${args[2]}`;
    if (args[0] === 'get' && args[1] === 'nodes') return cluster.nodes ? cluster.nodes() : '64Gi';
    if (args[0] === 'create' && args.includes('--dry-run=client')) return 'apiVersion: v1\nkind: Secret\n';
    if (args[1] === 'deployments,statefulsets,daemonsets,replicasets,jobs,pods') return JSON.stringify({ items: [] });
    return '';
  });
}
