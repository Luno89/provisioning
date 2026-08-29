import { clusterHost } from './cluster-dns.js';

import type { BindingTypeRecord } from './db-interface.js';

export const SERVICE_BINDING_ROOT = '/bindings';

const BINDING_TYPES: Record<string, string> = {
  mongo: 'mongodb',
  minio: 's3',
  qdrant: 'qdrant',
  quickwit: 'quickwit',
  tei: 'embeddings',
  verdaccio: 'npm',
  gitea: 'git',
};

export function bindingTypeFor(
  appType: string,
  dynamicTypes?: readonly BindingTypeRecord[],
): string | undefined {
  const norm = appType.trim().toLowerCase();
  if (dynamicTypes?.length) {
    const matched = dynamicTypes.find(
      (t) => (t.appType && t.appType.toLowerCase() === norm) || t.id.toLowerCase() === norm,
    );
    if (matched) return matched.id;
  }
  return BINDING_TYPES[norm];
}

export interface ServiceBindingContract {
  serviceName: string;
  namespace: string;
  port: number;
  bindingType: string;
  protocol?: 'http' | 'https' | 'tcp' | 'grpc' | undefined;
  secretName?: string | undefined;
  keyMapping?: Record<string, string> | undefined;
  isPlatformService?: boolean | undefined;
}

export const PLATFORM_SERVICE_CONTRACTS: Record<string, ServiceBindingContract> = {
  gitea: {
    serviceName: 'gitea-http',
    namespace: 'gitea',
    port: 3000,
    bindingType: 'git',
    protocol: 'http',
    secretName: 'gitea',
    keyMapping: { token: 'token' },
    isPlatformService: true,
  },
  'koala-vectors': {
    serviceName: 'qdrant',
    namespace: 'koala-vectors',
    port: 6333,
    bindingType: 'qdrant',
    protocol: 'http',
    isPlatformService: true,
  },
  'koala-index': {
    serviceName: 'quickwit',
    namespace: 'koala-index',
    port: 7280,
    bindingType: 'quickwit',
    protocol: 'http',
    isPlatformService: true,
  },
  'koala-embed': {
    serviceName: 'tei',
    namespace: 'koala-embed',
    port: 80,
    bindingType: 'embeddings',
    protocol: 'http',
    isPlatformService: true,
  },
  'koala-store': {
    serviceName: 'minio',
    namespace: 'koala-store',
    port: 9000,
    bindingType: 's3',
    protocol: 'http',
    secretName: 'minio',
    keyMapping: { rootUser: 'rootUser', rootPassword: 'rootPassword' },
    isPlatformService: true,
  },
};

export interface Binding {
  name: string;
  type: string;
  host: string;
  port: number;
  protocol?: string | undefined;
  keys: string[];
}

export function bindingFor(args: {
  name: string;
  appType: string;
  service: string;
  namespace: string;
  port: number;
  protocol?: string | undefined;
  keys?: string[];
  dynamicTypes?: readonly BindingTypeRecord[];
}): Binding | undefined {
  const type = bindingTypeFor(args.appType, args.dynamicTypes);
  if (!type) return undefined;
  return {
    name: args.name,
    type,
    host: clusterHost(args.service, args.namespace),
    port: args.port,
    ...(args.protocol ? { protocol: args.protocol } : {}),
    keys: args.keys ?? [],
  };
}

export function describeBindings(bindings: readonly Binding[] = []): string {
  const head = [
    'Services this project depends on are provided as FILES, following the Kubernetes Service',
    `Binding convention (servicebinding.io). The directory is in $SERVICE_BINDING_ROOT (${SERVICE_BINDING_ROOT}).`,
    '',
    'For a binding named `<name>`, read:',
    `  $SERVICE_BINDING_ROOT/<name>/type       what kind of service it is`,
    `  $SERVICE_BINDING_ROOT/<name>/host       and /port`,
    `  $SERVICE_BINDING_ROOT/<name>/username   and /password, when it needs credentials`,
    '',
    'Read these at runtime. Never hard-code a host, a port or a credential, and never write a',
    'credential into a repository — the values exist only inside the cluster.',
  ];

  if (!bindings.length) {
    return [
      ...head,
      '',
      'Nothing is bound to this project yet. If work needs a database, a cache or storage, say so —',
      'the binding is declared on the project and provided at deploy time.',
    ].join('\n');
  }

  const lines = bindings.map((b) => {
    const keys = b.keys.length ? `, plus ${b.keys.join(' and ')}` : '';
    return `  ${b.name}: type=${b.type}, host=${b.host}, port=${b.port}${keys}`;
  });
  return [...head, '', 'Bound to this project:', ...lines].join('\n');
}

export const bindingSecretName = (name: string) => `binding-${name}`;

export interface ProjectedBinding {
  name: string;
  secretName: string;
}

export function bindingProjection(bindings: readonly ProjectedBinding[]): {
  volumes: { name: string; secret: { secretName: string } }[];
  volumeMounts: { name: string; mountPath: string; readOnly: boolean }[];
  env: { name: string; value: string }[];
} {
  if (!bindings.length) return { volumes: [], volumeMounts: [], env: [] };
  const volumeName = (name: string) => `binding-${name}`;
  return {
    volumes: bindings.map((b) => ({
      name: volumeName(b.name),
      secret: { secretName: b.secretName },
    })),
    volumeMounts: bindings.map((b) => ({
      name: volumeName(b.name),
      mountPath: `${SERVICE_BINDING_ROOT}/${b.name}`,
      readOnly: true,
    })),
    env: [{ name: 'SERVICE_BINDING_ROOT', value: SERVICE_BINDING_ROOT }],
  };
}
