import { clusterHost } from './cluster-dns.js';

/**
 * How a workload is told where to reach a service it depends on.
 *
 * ── THIS IS A PUBLIC CONVENTION, NOT ONE WE INVENTED ──
 * The Service Binding Specification for Kubernetes (servicebinding.io, v1.1.0) projects bindings as
 * FILES in a directory, discovered through `$SERVICE_BINDING_ROOT`:
 *
 *     $SERVICE_BINDING_ROOT/<name>/type       required, e.g. "mongodb"
 *     $SERVICE_BINDING_ROOT/<name>/host
 *     $SERVICE_BINDING_ROOT/<name>/port
 *     $SERVICE_BINDING_ROOT/<name>/username
 *     $SERVICE_BINDING_ROOT/<name>/password
 *
 * Following it rather than inventing an env-var convention has two arguments. The weaker one is
 * that client libraries exist for Go, Python and Java. The stronger one is why the spec moved away
 * from environment variables in the first place: a secret in the environment appears in
 * `kubectl describe pod`, in crash dumps, in anything that logs its own env at startup, and cannot
 * be rotated without a restart. A file has none of those properties.
 *
 * There is no legacy application to accommodate here — the code reading these bindings is written
 * by Koala — so the only reason to prefer env vars would be that they are easier for me to
 * implement, which is not a reason.
 *
 * ── WHAT THIS MODULE IS NOT ──
 * The full spec involves a `ServiceBinding` custom resource, a controller and a mutating admission
 * webhook. That is a great deal of machinery for a local-first tool. This adopts the PROJECTION —
 * the directory layout and the key names, which is what an application actually sees — and mounts
 * a Secret to produce it. An app written against this works unmodified under a real
 * servicebinding.io implementation, which is the property worth having.
 */

/**
 * Where bindings are mounted.
 *
 * The spec says a value is assigned when the variable is absent, and names `/bindings` as the
 * conventional one. Setting it explicitly means an application never has to guess.
 */
import type { BindingTypeRecord } from './db-interface.js';

export const SERVICE_BINDING_ROOT = '/bindings';

/**
 * Built-in fallback binding types, used when dynamic database records are absent.
 */
const BINDING_TYPES: Record<string, string> = {
  mongo: 'mongodb',
  minio: 's3',
  qdrant: 'qdrant',
  quickwit: 'quickwit',
  tei: 'embeddings',
  verdaccio: 'npm',
  gitea: 'git',
};

/**
 * Resolves the spec binding type for an appType, consulting dynamic types first.
 */
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

/**
 * A self-describing contract that any deployment or in-cluster platform service can expose
 * so workloads can bind to it without needing a synthetic AppSpec.
 */
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

/**
 * Standard contracts for platform services deployed directly into the cluster.
 */
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

/** One service a workload has been bound to. */
export interface Binding {
  /** The directory name under the root, and how an app tells two bindings apart. */
  name: string;
  /** The spec's `type` file — what KIND of service this is, e.g. `mongodb`. */
  type: string;
  host: string;
  port: number;
  protocol?: string | undefined;
  /** Which credential keys will be present. Never the values — those exist only in the cluster. */
  keys: string[];
}

/**
 * A binding for a deployment, as an app will see it.
 *
 * The host is derived from the Service, never invented — see cluster-dns.ts for why one function
 * owns that string.
 */
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
  // A binding with no type is not projectable: `type` is the one required file, and an app uses it
  // to tell what it has been handed.
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

/**
 * What a planner or an executing agent is told about bindings.
 *
 * Composed rather than seeded into each persona's prompt, for the same reason `describeSandbox()`
 * is: seeding duplicates it across every persona, `ensurePersonas` only ever ADDS so existing users
 * would never receive it, and editing a persona would silently drop it. One source, always current.
 *
 * With no bindings this is the convention alone — worth saying, because an agent that does not know
 * the mechanism exists will hard-code a connection string instead of asking for one.
 */
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


/**
 * What the Secret holding a binding's files is called in the consumer's namespace.
 *
 * One function so the two writers — a deploy into an app's namespace and a leaf sandbox — cannot
 * disagree about the name, which would project a volume from a Secret nothing wrote.
 */
export const bindingSecretName = (name: string) => `binding-${name}`;

/** A binding as it exists in the cluster: a Secret in the CONSUMER's namespace. */
export interface ProjectedBinding {
  /** Directory name under the root. */
  name: string;
  /** The Secret holding this binding's files, already written into the consumer's namespace. */
  secretName: string;
}

/**
 * The pod-spec fragments that turn binding Secrets into files an app can read.
 *
 * Computed here rather than in the construct, for the same reason `renderApp` is: a decision that
 * can be unit-tested should not live in a package that needs a Terraform stack to exercise. The
 * construct spreads the result and makes no choices of its own.
 *
 * Each Secret is mounted READ-ONLY at `$SERVICE_BINDING_ROOT/<name>`, which is what the spec
 * describes — every key in the Secret becomes a file named for that key.
 */
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
      // Nothing should write to a binding; a credential an app can edit is one it can corrupt.
      readOnly: true,
    })),
    /**
     * Set explicitly rather than relying on the conventional default. The spec says an
     * implementation assigns a value when the variable is absent, so an app that reads the variable
     * works either way — but an app that reads it and finds nothing has to guess, and guessing is
     * what this whole convention exists to remove.
     */
    env: [{ name: 'SERVICE_BINDING_ROOT', value: SERVICE_BINDING_ROOT }],
  };
}
