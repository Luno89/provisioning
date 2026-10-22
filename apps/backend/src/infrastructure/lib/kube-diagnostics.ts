export const LOG_TAIL = 60;

export const PLATFORM_NAMESPACES = ['monitoring', 'gitea', 'traefik', 'kube-system', 'koala-egress', 'koala-registry', 'pipeline-builds', 'mongo'] as const;
export const NEVER_OPEN = ['infisical'] as const;

export function namespacesProblem(wanted: readonly string[]): string | undefined {
  if (wanted.length === 0) return 'name the platform namespaces to open';
  const closed = wanted.filter((name) => (NEVER_OPEN as readonly string[]).includes(name));
  if (closed.length) return `${closed.join(', ')} holds the vault and never opens to an agent`;
  const unknown = wanted.filter((name) => !(PLATFORM_NAMESPACES as readonly string[]).includes(name));
  if (unknown.length) return `${unknown.join(', ')} is not a platform namespace — the ones that can open are: ${PLATFORM_NAMESPACES.join(', ')}`;
  return undefined;
}
export const MAX_OUTPUT = 12_000;

export interface OwnedDeployment {
  name: string;
  namespace: string;
  clusterId: string;
  ownerId?: string | undefined;
}

export const namespaceOf = (deploymentName: string): string =>
  deploymentName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

export function findDeployment(wanted: string, deployments: readonly OwnedDeployment[], ownerId: string): OwnedDeployment | undefined {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return undefined;
  return deployments
    .filter((deployment) => deployment.ownerId === ownerId)
    .find((deployment) => deployment.name.toLowerCase() === needle || deployment.namespace === needle);
}

export const logsCommand = (namespace: string): string[] =>
  ['logs', '-n', namespace, '--all-containers', '--prefix', '--tail', String(LOG_TAIL), '-l', 'app'];

export const eventsCommand = (namespace: string): string[] =>
  ['get', 'events', '-n', namespace, '--sort-by=.lastTimestamp'];

export function trimOutput(raw: unknown, limit = MAX_OUTPUT): string {
  const text = String(raw ?? '').trim();
  if (text.length <= limit) return text;
  return `…[earlier output trimmed]\n${text.slice(-limit)}`;
}

export const READ_VERBS = ['get', 'describe', 'top'] as const;

export const READ_RESOURCES = [
  'pods', 'pod', 'po',
  'deployments', 'deployment', 'deploy',
  'replicasets', 'rs', 'statefulsets', 'sts', 'daemonsets', 'ds',
  'jobs', 'job', 'cronjobs',
  'services', 'service', 'svc', 'ingress', 'endpoints',
  'persistentvolumeclaims', 'pvc', 'persistentvolumes', 'pv',
  'events', 'ev',
  'nodes', 'node', 'no',
  'namespaces', 'namespace', 'ns',
] as const;

export const CLUSTER_SCOPED = new Set(['nodes', 'node', 'no', 'persistentvolumes', 'pv', 'namespaces', 'namespace', 'ns']);

export interface ReadRequest {
  verb: string;
  resource: string;
  name?: string | undefined;
}

export type ReadPlan = { argv: string[]; clusterScoped: boolean } | { refused: string };

export function planRead(request: ReadRequest, namespace: string | undefined): ReadPlan {
  const verb = String(request.verb ?? '').trim().toLowerCase();
  const resource = String(request.resource ?? '').trim().toLowerCase();

  if (!(READ_VERBS as readonly string[]).includes(verb)) {
    return { refused: `"${verb}" is not a way to read — use ${READ_VERBS.join(', ')}. Nothing here changes the cluster.` };
  }
  if (!(READ_RESOURCES as readonly string[]).includes(resource)) {
    const secretish = ['secret', 'secrets', 'configmap', 'configmaps', 'cm'].includes(resource);
    return {
      refused: secretish
        ? 'Secrets and ConfigMaps cannot be read — they hold the credentials the platform gives to apps.'
        : `"${resource}" is not a resource that can be read here — try pods, deployments, services, pvc, events or nodes.`,
    };
  }
  if (verb === 'top' && !['pods', 'pod', 'po', 'nodes', 'node', 'no'].includes(resource)) {
    return { refused: 'top reports usage for pods or nodes only.' };
  }

  const name = request.name?.trim();
  if (name && !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(name)) return { refused: `"${name}" is not a valid object name.` };

  const clusterScoped = CLUSTER_SCOPED.has(resource);
  if (!clusterScoped && !namespace) return { refused: 'say which of your deployments to look at' };
  return {
    argv: [verb, resource, ...(name ? [name] : []), ...(clusterScoped ? [] : ['-n', namespace!])],
    clusterScoped,
  };
}
