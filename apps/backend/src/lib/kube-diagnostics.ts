
export interface OwnedNamespace {
  name: string;
  namespace: string;
  ownerId?: string | undefined;
}

export const LOG_TAIL = 60;
const MAX_OUTPUT = 6000;

export const SYSTEM_NAMESPACES = ['monitoring', 'gitea', 'kube-system', 'pipeline-builds'] as const;

export function namespaceFor(
  wanted: string,
  deployments: readonly OwnedNamespace[],
  ownerId: string,
  options?: { isAdmin?: boolean | undefined; isEscalated?: boolean | undefined; allowedNamespaces?: readonly string[] | undefined } | undefined,
): string | undefined {
  const needle = wanted.trim().toLowerCase();
  if (options?.isAdmin || options?.isEscalated) {
    if (SYSTEM_NAMESPACES.some((s) => s.toLowerCase() === needle)) {
      return needle;
    }
    if (options?.allowedNamespaces?.some((s) => s.toLowerCase() === needle)) {
      return needle;
    }
  }
  const mine = deployments.filter((d) => d.ownerId === ownerId);
  const found = mine.find(
    (d) => d.name.toLowerCase() === needle || d.namespace.toLowerCase() === needle,
  );
  return found?.namespace;
}

export function logsCommand(namespace: string): string[] {
  const cmd = [
    'logs', '-n', namespace,
    '--all-containers', '--prefix', '--tail', String(LOG_TAIL), '--previous=false',
  ];
  if (!SYSTEM_NAMESPACES.includes(namespace as any)) {
    cmd.push('-l', 'app');
  }
  return cmd;
}

export function eventsCommand(namespace: string): string[] {
  return ['get', 'events', '-n', namespace, '--sort-by=.lastTimestamp'];
}

export function trimOutput(raw: string): string {
  const text = String(raw ?? '').trim();
  if (text.length <= MAX_OUTPUT) return text;
  return `…[earlier output trimmed]\n${text.slice(-MAX_OUTPUT)}`;
}

export const READ_VERBS = ['get', 'describe', 'logs', 'events', 'top'] as const;

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

const CLUSTER_SCOPED = new Set(['nodes', 'node', 'no', 'persistentvolumes', 'pv', 'namespaces', 'namespace', 'ns']);

export interface ReadRequest {
  verb: string;
  resource: string;
  name?: string | undefined;
  target?: string | undefined;
}

export interface ReadPlan {
  argv: string[];
  namespace?: string;
}

export function readableNamespaces(
  deployments: readonly OwnedNamespace[],
  sandboxNamespaces: readonly string[],
  ownerId: string,
  options?: { isAdmin?: boolean | undefined; isEscalated?: boolean | undefined; allowedNamespaces?: readonly string[] | undefined } | undefined,
): string[] {
  const system = (options?.isAdmin || options?.isEscalated)
    ? [...SYSTEM_NAMESPACES, ...(options?.allowedNamespaces ?? [])]
    : [];
  return Array.from(new Set([
    ...deployments.filter((d) => d.ownerId === ownerId).map((d) => d.namespace),
    ...sandboxNamespaces,
    ...system,
  ]));
}

export function planRead(
  request: ReadRequest,
  allowed: readonly string[],
): ReadPlan | { refused: string } {
  const verb = String(request.verb ?? '').trim().toLowerCase();
  const resource = String(request.resource ?? '').trim().toLowerCase();

  if (!(READ_VERBS as readonly string[]).includes(verb)) {
    return { refused: `"${verb}" is not a readable action. Allowed: ${READ_VERBS.join(', ')}. `
      + 'Changing the cluster goes through a leaf, which is reviewed and verified.' };
  }
  if (!(READ_RESOURCES as readonly string[]).includes(resource)) {
    const secretish = ['secret', 'secrets', 'configmap', 'configmaps'].includes(resource);
    return { refused: secretish
      ? `Secrets and ConfigMaps cannot be read — they hold the credentials this platform binds into apps.`
      : `"${resource}" is not a readable resource. Allowed: ${READ_RESOURCES.slice(0, 12).join(', ')}…` };
  }

  const name = request.name && /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(request.name) ? request.name : undefined;
  if (request.name && !name) return { refused: `"${request.name}" is not a valid object name.` };

  if (CLUSTER_SCOPED.has(resource)) {
    return { argv: [verb, resource, ...(name ? [name] : [])] };
  }

  const target = String(request.target ?? '').trim();
  if (!target) return { refused: 'Say which deployment or leaf sandbox to look at.' };
  const namespace = allowed.find((n) => n === target.toLowerCase()
    || n === target.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
  if (!namespace) return { refused: `No deployment or sandbox of yours named "${target}".` };

  return { argv: [verb, resource, ...(name ? [name] : []), '-n', namespace], namespace };
}
