import { nodeProcesses, succeeded } from '../../platform/index.js';
import { CLUSTER_TOOL_PATHS } from '../services/ClusterAccess.js';

const CLUSTER_SCOPED = [
  'clusterroles', 'clusterrolebindings', 'customresourcedefinitions', 'runtimeclasses', 'priorityclasses', 'storageclasses',
  'validatingwebhookconfigurations', 'mutatingwebhookconfigurations', 'validatingadmissionpolicies',
  'validatingadmissionpolicybindings',
];
const KUBE_SYSTEM = ['deployments', 'daemonsets', 'statefulsets', 'services', 'jobs', 'serviceaccounts', 'roles', 'rolebindings'];

interface Listed { items: { kind: string; metadata: { name: string } }[] }

const listed = async (kubeconfig: string, args: string[]): Promise<Listed['items']> =>
  (JSON.parse(await succeeded(nodeProcesses, { command: CLUSTER_TOOL_PATHS.kubectl, args: ['--kubeconfig', kubeconfig, 'get', ...args, '-o', 'json'] })) as Listed).items;

export async function clusterWide(kubeconfig: string): Promise<string[]> {
  const scoped = await listed(kubeconfig, [CLUSTER_SCOPED.join(',')]);
  const system = await listed(kubeconfig, [KUBE_SYSTEM.join(','), '-n', 'kube-system']);
  return [
    ...scoped.map((item) => `${item.kind}/${item.metadata.name}`),
    ...system.map((item) => `kube-system/${item.kind}/${item.metadata.name}`),
  ].sort();
}

export async function namespacesOf(kubeconfig: string): Promise<string[]> {
  return (await listed(kubeconfig, ['namespaces'])).map((item) => item.metadata.name).sort();
}

export async function volumesOf(kubeconfig: string): Promise<string[]> {
  return (await listed(kubeconfig, ['persistentvolumes'])).map((item) => item.metadata.name).sort();
}
