/**
 * A deployable app as DATA, so adding one stops being a code change.
 *
 * ── THE EXPERIMENT THIS IS ──
 * There are fifteen `-native` constructs totalling 3,038 lines, and they build the same five
 * resources: Namespace, Secret, PVC, Deployment, Service. `minio-native.ts` and `qdrant-native.ts`
 * are both exactly 158 lines and identical in structure — copy-paste with the values changed.
 *
 * If a spec can reproduce `minio` field for field, then most of those lines were never code, and
 * adding MongoDB is inserting a record rather than writing TypeScript. That is what makes the
 * catalogue something Koala can extend safely: a closed schema is checkable in a way arbitrary code
 * and arbitrary Helm charts are not.
 *
 * ── WHAT STAYS CODE, AND WHY ──
 * Three things here are RULES rather than values, and belong in the renderer:
 *
 *   · a volume forces `Recreate` — a ReadWriteOnce PVC cannot be mounted by two pods, so the
 *     default rolling update deadlocks waiting for a pod that cannot start until the old one goes;
 *   · a generated credential becomes a Secret plus `valueFrom.secretKeyRef`, never a literal in the
 *     pod spec, so nothing that authors a spec ever holds the value;
 *   · labels and selectors must agree, which is not a decision anyone should be able to get wrong.
 *
 * Apps with genuine logic — odoo at 206 lines, nextcloud at 215 — can stay constructs forever. The
 * point is not to delete constructs; it is that the ORDINARY case should not need one.
 */

/** A port the container listens on. `name` is required: Services reference ports by it. */
export interface SpecPort {
  name: string;
  port: number;
}

/** An environment variable. `generate` means the platform mints it and injects it from a Secret. */
export interface SpecEnv {
  name: string;
  value?: string;
  /** The secret key it is read from. Present when the value is generated rather than given. */
  fromSecret?: string;
  generate?: 'password' | 'username';
}

export interface SpecVolume {
  /** Where it mounts in the container. */
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
  /** Container arguments, when the image needs them. */
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
  /** Which port a person's browser should reach. Often not the API port. */
  ingressPort?: number;
}

/** What a rendered app needs from the deployment, as opposed to from its spec. */
export interface RenderContext {
  /** Unique per deployment; labels and selectors are built from it. */
  id: string;
  namespace: string;
  serviceType: string;
  /** Generated values, keyed by secret key. Minted by the caller — never by the spec. */
  secrets: Record<string, string>;
  /** Overrides for a specific deployment: a bigger disk, a different tag. */
  storage?: Record<string, string>;
  memoryLimit?: string;
}

/**
 * The resource configuration a spec renders to.
 *
 * Plain objects rather than CDKTF constructs, so this is testable without a Terraform stack and the
 * same rendering can be diffed against a hand-written construct field by field.
 */
export interface RenderedApp {
  namespace: { metadata: { name: string } };
  secret?: { metadata: { name: string; namespace: string }; data: Record<string, string>; type: string };
  pvcs: { metadata: { name: string; namespace: string }; spec: unknown; waitUntilBound: boolean }[];
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  /** Which port a browser should reach. Absent for apps with nothing a person would open. */
  ingressPort?: number;
  /** Where the platform's own probe should look, so a spec-deployed app reports health like any other. */
  health?: { port: number; path: string };
}

const secretName = (id: string) => `${id}-secret`;
const pvcName = (id: string, index: number) => (index === 0 ? `${id}-data-pvc` : `${id}-data-${index}-pvc`);
const volumeName = (index: number) => (index === 0 ? 'data' : `data-${index}`);

/**
 * A spec plus a deployment's context, as Kubernetes resource configuration.
 *
 * Deliberately total: every field a construct sets is set here, so a difference against one is a
 * real difference rather than something this forgot to render.
 */
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
            // A generated value is read from the Secret, never written into the pod spec — which is
            // what keeps it out of anything that can author or read a spec.
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
            // Plaintext: the provider base64-encodes `data` itself.
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
        /**
         * A volume forces Recreate. A ReadWriteOnce PVC cannot be mounted by two pods, so a rolling
         * update deadlocks: the new pod waits for the volume, which waits for the old pod to go,
         * which waits for the new pod to be ready. A rule, not a value — which is why it is here.
         */
        ...(volumes.length ? { strategy: { type: 'Recreate' } } : {}),
        selector: { matchLabels: { app: label } },
        template: { metadata: { labels: { app: label } }, spec: podSpec },
      },
    },
    /**
     * Only when the app has something a person would open. A database has no console, and an
     * ingress pointing at one is a hostname that answers with a protocol error.
     */
    ...(spec.ingressPort ? { ingressPort: spec.ingressPort } : {}),
    /**
     * Liveness is what the platform's probe should watch — readiness goes false for ordinary
     * reasons (a MinIO still scanning its disk) and would report a healthy app as down.
     */
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

/**
 * MinIO, as data — the experiment.
 *
 * Every value here is read off `constructs/minio-native.ts`, including the parts that carry a reason:
 * `--console-address` is explicit because MinIO otherwise picks a random console port on restart,
 * and readiness uses `/ready` rather than `/live` because a MinIO that is up but still scanning its
 * disk answers live and refuses writes.
 *
 * Those reasons live in the construct's comments and are worth keeping there. What this shows is
 * that the RESOURCES need no code.
 */
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


/**
 * A spec as it is stored, with the provenance the record needs and the spec does not.
 *
 * `builtIn` is what makes seeding safe to re-run: the setup seeds these on every start, so a
 * built-in that someone has edited must not be silently reverted, and a user's own spec must not be
 * deleted because it is absent from the repo. Which of the two a record is decides both.
 */
export interface StoredAppSpec {
  id: string;
  spec: AppSpec;
  /** Shipped in the repo, as opposed to written here. */
  builtIn: boolean;
  /** Absent for built-ins: they belong to the platform, not to a person. */
  ownerId?: string;
  /** Set once a person has changed a built-in, so seeding leaves it alone from then on. */
  editedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The specs shipped in the repo, seeded into the database on setup.
 *
 * ── WHY BOTH A REPO AND A DATABASE ──
 * Specs live in the database so they can be edited at runtime, which is the whole point. But a
 * fresh `git clone && npm run setup` has an empty database, and a platform that can deploy nothing
 * until someone types a spec is not functional. So the repo carries the seeds and the database is
 * the runtime source — one place to read from, no second lookup path to drift.
 *
 * This list grows as each construct is verified against a spec, not in one sweep: `minio` is here
 * because `app-spec.test.ts` renders it and checks the result field for field against
 * `minio-native.ts`. Adding one without that check would be asserting the abstraction fits rather
 * than showing it.
 */
export const BUILT_IN_SPECS: AppSpec[] = [MINIO_SPEC];

/**
 * The specs to write, given what is already stored.
 *
 * Idempotent, and deliberately conservative about what it overwrites:
 *
 *   · a built-in that is missing is added — this is the fresh-clone case;
 *   · a built-in the repo has CHANGED is updated, so a fix ships;
 *   · a built-in someone has EDITED is left alone, because reverting a deliberate change on every
 *     restart is worse than shipping an out-of-date default;
 *   · anything not built in is never touched.
 */
export function specsToSeed(
  stored: readonly StoredAppSpec[],
  builtIn: readonly AppSpec[] = BUILT_IN_SPECS,
): AppSpec[] {
  const byId = new Map(stored.map((s) => [s.id, s]));
  return builtIn.filter((spec) => {
    const existing = byId.get(spec.id);
    if (!existing) return true;
    if (existing.editedAt) return false;
    // Compared by value: an unchanged spec should not churn `updatedAt` on every start.
    return JSON.stringify(existing.spec) !== JSON.stringify(spec);
  });
}
