import { withBuiltIns } from './ownership.js';

export interface SpecPort {
  name: string;
  port: number;
}

export interface SpecEnv {
  name: string;
  value?: string;
  fromSecret?: string;
  generate?: 'password' | 'username';
}

export interface SpecVolume {
  path: string;
  size: string;
}

export interface SpecProbe {
  path: string;
  port: number;
  initialDelaySeconds?: number;
  periodSeconds?: number;
}

export interface AppSpec {
  id: string;
  image: string;
  args?: string[];
  ports: SpecPort[];
  env?: SpecEnv[];
  volumes?: SpecVolume[];
  liveness?: SpecProbe;
  readiness?: SpecProbe;
  resources?: {
    limits?: { cpu?: string; memory?: string };
    requests?: { cpu?: string; memory?: string };
  };
  ingressPort?: number;
}

export interface RenderContext {
  id: string;
  namespace: string;
  serviceType: string;
  secrets: Record<string, string>;
  storage?: Record<string, string>;
  memoryLimit?: string;
}

export interface RenderedApp {
  namespace: { metadata: { name: string } };
  secret?: { metadata: { name: string; namespace: string }; data: Record<string, string>; type: string };
  pvcs: { metadata: { name: string; namespace: string }; spec: unknown; waitUntilBound: boolean }[];
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  ingressPort?: number;
  health?: { port: number; path: string };
}

const secretName = (id: string) => `${id}-secret`;
const pvcName = (id: string, index: number) => (index === 0 ? `${id}-data-pvc` : `${id}-data-${index}-pvc`);
const volumeName = (index: number) => (index === 0 ? 'data' : `data-${index}`);

export function renderApp(spec: AppSpec, ctx: RenderContext): RenderedApp {
  const label = `${spec.id}-${ctx.id}`;
  const volumes = spec.volumes ?? [];
  const generated = (spec.env ?? []).filter((e) => e.fromSecret);

  const container: Record<string, unknown> = {
    name: spec.id,
    image: spec.image,
    ...(spec.args?.length ? { args: spec.args } : {}),
    ...(spec.env?.length
      ? {
          env: spec.env.map((e) =>
            e.fromSecret
              ? { name: e.name, valueFrom: { secretKeyRef: { name: secretName(spec.id), key: e.fromSecret } } }
              : { name: e.name, value: e.value ?? '' }),
        }
      : {}),
    port: spec.ports.map((p) => ({ containerPort: p.port, name: p.name })),
    ...(volumes.length
      ? { volumeMount: volumes.map((v, i) => ({ name: volumeName(i), mountPath: v.path })) }
      : {}),
    ...(spec.resources
      ? {
          resources: {
            ...(spec.resources.limits
              ? { limits: { ...spec.resources.limits, ...(ctx.memoryLimit ? { memory: ctx.memoryLimit } : {}) } }
              : {}),
            ...(spec.resources.requests ? { requests: spec.resources.requests } : {}),
          },
        }
      : {}),
    ...(spec.liveness ? { livenessProbe: probeFor(spec.liveness) } : {}),
    ...(spec.readiness ? { readinessProbe: probeFor(spec.readiness) } : {}),
  };

  const podSpec = {
    container: [container],
    ...(volumes.length
      ? {
          volume: volumes.map((_, i) => ({
            name: volumeName(i),
            persistentVolumeClaim: { claimName: pvcName(spec.id, i) },
          })),
        }
      : {}),
  };

  return {
    namespace: { metadata: { name: ctx.namespace } },
    ...(generated.length
      ? {
          secret: {
            metadata: { name: secretName(spec.id), namespace: ctx.namespace },
            data: ctx.secrets,
            type: 'Opaque',
          },
        }
      : {}),
    pvcs: volumes.map((v, i) => ({
      metadata: { name: pvcName(spec.id, i), namespace: ctx.namespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: ctx.storage?.[v.path] ?? v.size } },
      },
      waitUntilBound: false,
    })),
    deployment: {
      metadata: { name: spec.id, namespace: ctx.namespace, labels: { app: label } },
      spec: {
        replicas: '1',
        ...(volumes.length ? { strategy: { type: 'Recreate' } } : {}),
        selector: { matchLabels: { app: label } },
        template: { metadata: { labels: { app: label } }, spec: podSpec },
      },
    },
    ...(spec.ingressPort ? { ingressPort: spec.ingressPort } : {}),
    ...(spec.liveness ? { health: { port: spec.liveness.port, path: spec.liveness.path } } : {}),
    service: {
      metadata: { name: spec.id, namespace: ctx.namespace },
      spec: {
        type: ctx.serviceType,
        selector: { app: label },
        port: spec.ports.map((p) => ({ port: p.port, targetPort: String(p.port), name: p.name })),
      },
    },
  };
}

function probeFor(probe: SpecProbe) {
  return {
    httpGet: { path: probe.path, port: String(probe.port) },
    ...(probe.initialDelaySeconds !== undefined ? { initialDelaySeconds: probe.initialDelaySeconds } : {}),
    ...(probe.periodSeconds !== undefined ? { periodSeconds: probe.periodSeconds } : {}),
  };
}

export const MINIO_SPEC: AppSpec = {
  id: 'minio',
  image: 'minio/minio:latest',
  args: ['server', '/data', '--console-address', ':9001'],
  ports: [{ name: 's3', port: 9000 }, { name: 'console', port: 9001 }],
  env: [
    { name: 'MINIO_ROOT_USER', fromSecret: 'root_user', generate: 'username' },
    { name: 'MINIO_ROOT_PASSWORD', fromSecret: 'root_password', generate: 'password' },
  ],
  volumes: [{ path: '/data', size: '100Gi' }],
  liveness: { path: '/minio/health/live', port: 9000, initialDelaySeconds: 10, periodSeconds: 20 },
  readiness: { path: '/minio/health/ready', port: 9000, initialDelaySeconds: 5, periodSeconds: 10 },
  resources: { limits: { memory: '2Gi', cpu: '2000m' }, requests: { memory: '256Mi', cpu: '100m' } },
  ingressPort: 9001,
};

export interface StoredAppSpec {
  id: string;
  spec: AppSpec;
  builtIn: boolean;
  ownerId?: string;
  editedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const BUILT_IN_SPECS: AppSpec[] = [MINIO_SPEC];

export function specsToSeed(
  stored: readonly StoredAppSpec[],
  builtIn: readonly AppSpec[] = BUILT_IN_SPECS,
): AppSpec[] {
  const byId = new Map(stored.map((s) => [s.id, s]));
  return builtIn.filter((spec) => {
    const existing = byId.get(spec.id);
    if (!existing) return true;
    if (existing.editedAt) return false;
    return JSON.stringify(existing.spec) !== JSON.stringify(spec);
  });
}

/**
 * The specs this user can see: the shipped ones, with their own in place of any they replaced.
 *
 * `resolveBindings` builds its lookup as `new Map(specs.map(...))`, so an unfiltered list lets the
 * LAST spec with a given id win — which across tenants means somebody else's. Filtering here keeps
 * that decision in one place rather than at each of the four readers.
 */
export function visibleAppSpecs(specs: readonly StoredAppSpec[], userId: string): StoredAppSpec[] {
  return withBuiltIns(specs, userId, (s) => s.id);
}

export interface AppSpecSeedStore {
  getAppSpecs(): Promise<StoredAppSpec[]>;
  saveAppSpec(spec: StoredAppSpec): Promise<void>;
}

export async function seedAppSpecs(store: AppSpecSeedStore): Promise<number> {
  const stored = await store.getAppSpecs();
  const pending = specsToSeed(stored);
  if (!pending.length) return 0;
  const now = new Date().toISOString();
  for (const spec of pending) {
    const existing = stored.find((s) => s.id === spec.id);
    await store.saveAppSpec({
      id: spec.id,
      spec,
      builtIn: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
  return pending.length;
}
