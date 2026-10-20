export const POOL_LABEL = 'koala.dev/pool';
export const OWNER_LABEL = 'koala.dev/owner';
export const RUNTIME_CLASS = 'gvisor';
export const VCLUSTER_CHART_VERSION = '0.37.2';
export const ADMISSION_POLICY = 'koala-pool-gvisor';
export const PROXY = { namespace: 'kube-system', name: 'pool-proxy' } as const;
export const PROXY_IMAGE = 'caddy:2.10.2-alpine';
export const INSTANCE_RELEASE = { name: 'instance', namespace: 'nowrinkles' } as const;
export const GITEA_SERVICE = { name: 'gitea-http', namespace: 'gitea', port: 3000 } as const;
export const FIRST_PORT = 35000;
export const LAST_PORT = 35999;

export interface PoolPorts {
  backend: number;
  edge: number;
  registry: number;
}

export interface PoolSlot {
  memoryMiB: number;
  cpu: number;
  storageGiB: number;
}

export const poolNamespace = (name: string): string => `pool-${name}`;

export const syncedService = (service: string, namespace: string, vcluster: string): string => `${service}-x-${namespace}-x-${vcluster}`;

export function poolSlots(totalMemoryMiB: number, reservedMiB: number, slot: PoolSlot): number {
  return Math.max(0, Math.floor((totalMemoryMiB - reservedMiB) / slot.memoryMiB));
}

export function freePorts(used: readonly PoolPorts[]): PoolPorts | undefined {
  const taken = new Set(used.flatMap((ports) => [ports.backend, ports.edge, ports.registry]));
  for (let start = FIRST_PORT; start + 2 <= LAST_PORT; start += 3) {
    if (!taken.has(start) && !taken.has(start + 1) && !taken.has(start + 2)) return { backend: start, edge: start + 1, registry: start + 2 };
  }
  return undefined;
}

export function namespaceManifest(name: string, ownerId: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: poolNamespace(name),
      labels: {
        [POOL_LABEL]: 'true',
        [OWNER_LABEL]: ownerId,
        'pod-security.kubernetes.io/enforce': 'baseline',
        'pod-security.kubernetes.io/enforce-version': 'latest',
      },
    },
  };
}

export function admissionManifests(): Record<string, unknown>[] {
  return [
    {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicy',
      metadata: { name: ADMISSION_POLICY },
      spec: {
        failurePolicy: 'Fail',
        matchConstraints: {
          namespaceSelector: { matchLabels: { [POOL_LABEL]: 'true' } },
          resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['pods'] }],
        },
        validations: [{
          expression: `has(object.spec.runtimeClassName) && object.spec.runtimeClassName == '${RUNTIME_CLASS}'`,
          message: 'a pod in a pool instance runs under gVisor',
        }],
      },
    },
    {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicyBinding',
      metadata: { name: ADMISSION_POLICY },
      spec: { policyName: ADMISSION_POLICY, validationActions: ['Deny'] },
    },
  ];
}

export const vclusterAddress = (name: string): string => `${name}.${poolNamespace(name)}.svc`;

export function vclusterValues(name: string, slot: PoolSlot): Record<string, unknown> {
  return {
    controlPlane: { statefulSet: { runtimeClassName: RUNTIME_CLASS }, proxy: { extraSANs: [vclusterAddress(name)] } },
    sync: { toHost: { pods: { runtimeClassName: RUNTIME_CLASS } } },
    policies: {
      resourceQuota: {
        enabled: true,
        quota: {
          'count/pods': 80,
          'count/services': 50,
          'count/endpoints': 100,
          'count/persistentvolumeclaims': 30,
          'requests.memory': `${slot.memoryMiB}Mi`,
          'limits.memory': `${slot.memoryMiB * 4}Mi`,
          'requests.cpu': `${slot.cpu}`,
          'limits.cpu': `${slot.cpu * 50}`,
          'requests.storage': `${slot.storageGiB}Gi`,
          'requests.ephemeral-storage': `${slot.storageGiB}Gi`,
          'limits.ephemeral-storage': `${slot.storageGiB * 10}Gi`,
          'services.nodeports': 0,
          'services.loadbalancers': 0,
        },
      },
      limitRange: {
        enabled: true,
        default: { memory: '1Gi', cpu: '2', 'ephemeral-storage': '8Gi' },
        defaultRequest: { memory: '64Mi', cpu: '20m', 'ephemeral-storage': '128Mi' },
      },
      networkPolicy: { enabled: true },
    },
  };
}

export interface ProxiedInstance {
  name: string;
  ports: PoolPorts;
}

const passThrough = (target: string): string[] => [
  `\treverse_proxy ${target} {`,
  '\t\ttransport http {',
  '\t\t\tread_timeout 0',
  '\t\t\twrite_timeout 0',
  '\t\t}',
  '\t}',
];

export function proxyCaddyfile(instances: readonly ProxiedInstance[], address: string): string {
  const blocks = [...instances].sort((a, b) => a.name.localeCompare(b.name)).flatMap((instance) => {
    const namespace = poolNamespace(instance.name);
    const service = (name: string, inNamespace: string) => `${syncedService(name, inNamespace, instance.name)}.${namespace}.svc.cluster.local`;
    return [
      `http://:${instance.ports.backend} {`, `\tbind ${address}`, ...passThrough(`${service(INSTANCE_RELEASE.name, INSTANCE_RELEASE.namespace)}:80`), '}',
      `http://:${instance.ports.edge} {`, `\tbind ${address}`, ...passThrough(`${service(`${INSTANCE_RELEASE.name}-edge`, INSTANCE_RELEASE.namespace)}:80`), '}',
      `http://:${instance.ports.registry} {`, '\tbind 127.0.0.1', ...passThrough(`${service(GITEA_SERVICE.name, GITEA_SERVICE.namespace)}:${GITEA_SERVICE.port}`), '}',
    ];
  });
  return [`{`, '\tadmin off', '\tauto_https off', '\tpersist_config off', '}', '', ...blocks, ''].join('\n');
}

export function proxyManifests(caddyfile: string): Record<string, unknown>[] {
  return [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: PROXY.name, namespace: PROXY.namespace },
      data: { Caddyfile: caddyfile },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: PROXY.name, namespace: PROXY.namespace, labels: { app: PROXY.name } },
      spec: {
        selector: { matchLabels: { app: PROXY.name } },
        template: {
          metadata: { labels: { app: PROXY.name } },
          spec: {
            hostNetwork: true,
            dnsPolicy: 'ClusterFirstWithHostNet',
            containers: [{
              name: 'caddy',
              image: PROXY_IMAGE,
              args: ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--watch'],
              resources: { requests: { cpu: '20m', memory: '32Mi' }, limits: { memory: '256Mi' } },
              volumeMounts: [{ name: 'config', mountPath: '/etc/caddy' }],
            }],
            volumes: [{ name: 'config', configMap: { name: PROXY.name } }],
          },
        },
      },
    },
  ];
}

export interface PoolChartInput {
  instanceId: string;
  ownerId: string;
  rootUrl: string;
  rootPublicKeys: string;
  credential: string;
  name: string;
  domain?: string | undefined;
  publicUrl: string;
  image: { repository: string; tag: string };
  ports: PoolPorts;
  resources: Record<string, unknown>;
}

export function poolChartValues(input: PoolChartInput): Record<string, unknown> {
  return {
    image: { repository: input.image.repository, tag: input.image.tag, pullPolicy: 'IfNotPresent' },
    instance: {
      id: input.instanceId,
      ownerId: input.ownerId,
      rootUrl: input.rootUrl,
      rootPublicKeys: Buffer.from(input.rootPublicKeys, 'utf8').toString('base64'),
      credential: input.credential,
    },
    publicUrl: input.publicUrl,
    ...(input.domain ? { routing: { name: input.name, domain: input.domain } } : {}),
    hostDocker: false,
    pool: { enabled: true, registryPullHost: `127.0.0.1:${input.ports.registry}` },
    resources: input.resources,
  };
}

export interface PoolSettings {
  kubeconfig: string;
  address: string;
  slots: number;
  slot: PoolSlot;
  image: { repository: string; tag: string };
  trialDays: number;
}

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const DEFAULT_TRIAL_DAYS = 14;

export function poolSettingsFrom(env: Readonly<Record<string, string | undefined>>, defaultKubeconfig: string): PoolSettings | { off: string } {
  if (!env.INGRESS_DOMAIN?.trim()) return { off: 'this root gives instances no addresses of their own (no INGRESS_DOMAIN)' };
  if (!env.POOL_ADDRESS?.trim()) return { off: 'this root has no pool (POOL_ADDRESS is not set)' };
  const slots = Number(env.POOL_SLOTS);
  if (!Number.isInteger(slots) || slots <= 0) return { off: 'this root has no pool slots (POOL_SLOTS)' };
  const registry = env.INSTANCE_REGISTRY?.trim();
  const repository = env.POOL_IMAGE?.trim() || (registry ? `${registry}/nowrinkles/app` : '');
  if (!repository) return { off: 'this root has no image for pool instances (POOL_IMAGE or INSTANCE_REGISTRY)' };
  return {
    kubeconfig: env.POOL_KUBECONFIG?.trim() || defaultKubeconfig,
    address: env.POOL_ADDRESS.trim(),
    slots,
    slot: {
      memoryMiB: positive(env.POOL_SLOT_MEMORY_MIB, 6144),
      cpu: positive(env.POOL_SLOT_CPU, 2),
      storageGiB: positive(env.POOL_SLOT_STORAGE_GIB, 60),
    },
    image: { repository, tag: env.POOL_IMAGE_TAG?.trim() || env.INSTANCE_IMAGE_TAG?.trim() || 'dev' },
    trialDays: positive(env.POOL_TRIAL_DAYS, DEFAULT_TRIAL_DAYS),
  };
}

export const COMPONENT_RESOURCES: Record<string, unknown> = {
  backend: { requests: { memory: '384Mi', cpu: '50m' }, limits: { memory: '1Gi' } },
  'worker-engine': { requests: { memory: '512Mi', cpu: '50m' }, limits: { memory: '1536Mi' } },
  'worker-cluster': { requests: { memory: '512Mi', cpu: '20m' }, limits: { memory: '1536Mi' } },
  'worker-host': { requests: { memory: '384Mi', cpu: '20m' }, limits: { memory: '1Gi' } },
  edge: { requests: { memory: '32Mi', cpu: '10m' }, limits: { memory: '256Mi' } },
  mongo: { requests: { memory: '256Mi', cpu: '50m' }, limits: { memory: '1Gi' } },
  temporal: { requests: { memory: '192Mi', cpu: '50m' }, limits: { memory: '768Mi' } },
  temporalDb: { requests: { memory: '128Mi', cpu: '20m' }, limits: { memory: '512Mi' } },
};

export interface PoolPolicy {
  trialDays: number;
  updatedAt: string;
  updatedBy: string;
}

export const MAX_TRIAL_DAYS = 365;

export function trialDaysProblem(days: unknown): string | null {
  return typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= MAX_TRIAL_DAYS ? null : `a trial is a whole number of days from 1 to ${MAX_TRIAL_DAYS}`;
}
