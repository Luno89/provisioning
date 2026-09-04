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
  /** Required for a persistent volume (PVC size); for an ephemeral one, only meaningful together with `medium: 'Memory'` (sizeLimit). */
  size?: string;
  /** Default 'persistent' (a PVC). 'ephemeral' renders as an emptyDir instead — nothing survives a pod restart. */
  type?: 'persistent' | 'ephemeral';
  /** 'Memory' backs the emptyDir with RAM (e.g. a real /dev/shm) rather than node disk. */
  medium?: 'Memory';
}

export interface SpecProbe {
  path: string;
  port: number;
  initialDelaySeconds?: number;
  periodSeconds?: number;
}

export interface SpecConfigFile {
  /** Becomes the ConfigMap data key, and the filename once mounted. */
  name: string;
  content: string;
  /** Directory the ConfigMap is mounted at, read-only. All of a spec's configFiles share one mount. */
  mountPath: string;
}

export interface AppSpec {
  id: string;
  image: string;
  /** Overrides the image's entrypoint — needed only when a config file has to be copied/substituted before the real process starts. */
  command?: string[];
  args?: string[];
  ports: SpecPort[];
  env?: SpecEnv[];
  volumes?: SpecVolume[];
  configFiles?: SpecConfigFile[];
  securityContext?: { runAsUser?: string; runAsGroup?: string; fsGroup?: string };
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
  configMap?: { metadata: { name: string; namespace: string }; data: Record<string, string> };
  pvcs: { metadata: { name: string; namespace: string }; spec: unknown; waitUntilBound: boolean }[];
  deployment: Record<string, unknown>;
  service: Record<string, unknown>;
  ingressPort?: number;
  health?: { port: number; path: string };
}

const secretName = (id: string) => `${id}-secret`;
const pvcName = (id: string, index: number) => (index === 0 ? `${id}-data-pvc` : `${id}-data-${index}-pvc`);
const volumeName = (index: number) => (index === 0 ? 'data' : `data-${index}`);

const isEphemeral = (v: SpecVolume) => (v.type ?? 'persistent') === 'ephemeral';
const configMapName = (id: string) => `${id}-config`;

export function renderApp(spec: AppSpec, ctx: RenderContext): RenderedApp {
  const label = `${spec.id}-${ctx.id}`;
  const volumes = spec.volumes ?? [];
  const configFiles = spec.configFiles ?? [];
  const generated = (spec.env ?? []).filter((e) => e.fromSecret);

  const volumeMounts = [
    ...volumes.map((v, i) => ({ name: volumeName(i), mountPath: v.path })),
    ...(configFiles.length ? [{ name: 'config-src', mountPath: configFiles[0]!.mountPath, readOnly: true }] : []),
  ];

  const container: Record<string, unknown> = {
    name: spec.id,
    image: spec.image,
    ...(spec.command?.length ? { command: spec.command } : {}),
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
    ...(volumeMounts.length ? { volumeMount: volumeMounts } : {}),
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

  const podVolumes = [
    ...volumes.map((v, i) => (
      isEphemeral(v)
        ? { name: volumeName(i), emptyDir: v.medium ? { medium: v.medium, sizeLimit: v.size } : {} }
        : { name: volumeName(i), persistentVolumeClaim: { claimName: pvcName(spec.id, i) } }
    )),
    ...(configFiles.length ? [{ name: 'config-src', configMap: { name: configMapName(spec.id) } }] : []),
  ];

  const podSpec = {
    container: [container],
    ...(spec.securityContext ? { securityContext: spec.securityContext } : {}),
    ...(podVolumes.length ? { volume: podVolumes } : {}),
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
    ...(configFiles.length
      ? {
          configMap: {
            metadata: { name: configMapName(spec.id), namespace: ctx.namespace },
            data: Object.fromEntries(configFiles.map((f) => [f.name, f.content])),
          },
        }
      : {}),
    pvcs: volumes
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => !isEphemeral(v))
      .map(({ v, i }) => ({
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
        // ReadWriteOnce PVC: a rolling update would deadlock on a volume the old pod still holds.
        ...(volumes.some((v) => !isEphemeral(v)) ? { strategy: { type: 'Recreate' } } : {}),
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

export const JELLYFIN_SPEC: AppSpec = {
  id: 'jellyfin',
  image: 'jellyfin/jellyfin:latest',
  ports: [{ name: 'http', port: 8096 }],
  volumes: [{ path: '/config', size: '2Gi' }, { path: '/cache', size: '2Gi' }, { path: '/media', size: '10Gi' }],
  liveness: { path: '/', port: 8096 },
  resources: { limits: { memory: '2Gi', cpu: '1000m' }, requests: { memory: '256Mi', cpu: '100m' } },
  ingressPort: 8096,
};

export const PLEX_SPEC: AppSpec = {
  id: 'plex',
  image: 'plexinc/pms-docker:latest',
  ports: [{ name: 'http', port: 32400 }],
  volumes: [{ path: '/config', size: '2Gi' }, { path: '/data', size: '10Gi' }],
  liveness: { path: '/', port: 32400 },
  resources: { limits: { memory: '2Gi', cpu: '1000m' }, requests: { memory: '256Mi', cpu: '100m' } },
  ingressPort: 32400,
};

export const NAVIDROME_SPEC: AppSpec = {
  id: 'navidrome',
  image: 'deluan/navidrome:latest',
  env: [
    { name: 'ND_DATAFOLDER', value: '/data' },
    { name: 'ND_MUSICFOLDER', value: '/music' },
    { name: 'ND_PORT', value: '4533' },
  ],
  ports: [{ name: 'http', port: 4533 }],
  volumes: [{ path: '/data', size: '2Gi' }, { path: '/music', size: '5Gi' }],
  liveness: { path: '/', port: 4533 },
  resources: { limits: { memory: '1Gi', cpu: '500m' }, requests: { memory: '128Mi', cpu: '50m' } },
  ingressPort: 4533,
};

export const KAVITA_SPEC: AppSpec = {
  id: 'kavita',
  image: 'ghcr.io/kareadita/kavita:latest',
  ports: [{ name: 'http', port: 5000 }],
  volumes: [{ path: '/kavita/config', size: '2Gi' }, { path: '/manga', size: '5Gi' }],
  liveness: { path: '/', port: 5000 },
  resources: { limits: { memory: '1Gi', cpu: '500m' }, requests: { memory: '128Mi', cpu: '50m' } },
  ingressPort: 5000,
};

export const IMMICH_SPEC: AppSpec = {
  id: 'immich',
  image: 'ghcr.io/immich-app/immich-server:release',
  ports: [{ name: 'http', port: 2283 }],
  volumes: [{ path: '/usr/src/app/upload', size: '10Gi' }],
  liveness: { path: '/', port: 2283 },
  resources: { limits: { memory: '2Gi', cpu: '1000m' }, requests: { memory: '256Mi', cpu: '100m' } },
  ingressPort: 2283,
};

export const HOMEASSISTANT_SPEC: AppSpec = {
  id: 'homeassistant',
  image: 'ghcr.io/home-assistant/home-assistant:stable',
  ports: [{ name: 'http', port: 8123 }],
  volumes: [{ path: '/config', size: '2Gi' }],
  liveness: { path: '/', port: 8123 },
  resources: { limits: { memory: '1Gi', cpu: '500m' }, requests: { memory: '128Mi', cpu: '50m' } },
  ingressPort: 8123,
};

export const PAPRA_SPEC: AppSpec = {
  id: 'papra',
  image: 'ghcr.io/papra-hq/papra:latest',
  ports: [{ name: 'http', port: 1221 }],
  volumes: [{ path: '/data', size: '2Gi' }, { path: '/media', size: '5Gi' }],
  liveness: { path: '/', port: 1221 },
  resources: { limits: { memory: '1Gi', cpu: '500m' }, requests: { memory: '128Mi', cpu: '50m' } },
  ingressPort: 1221,
};

export const AUDIOBOOKSHELF_SPEC: AppSpec = {
  id: 'audiobookshelf',
  image: 'ghcr.io/advplyr/audiobookshelf:latest',
  env: [
    { name: 'PORT', value: '80' },
    { name: 'METADATA_PATH', value: '/metadata' },
    { name: 'CONFIG_PATH', value: '/config' },
  ],
  ports: [{ name: 'http', port: 80 }],
  volumes: [{ path: '/metadata', size: '2Gi' }, { path: '/config', size: '1Gi' }, { path: '/audiobooks', size: '5Gi' }],
  liveness: { path: '/', port: 80 },
  resources: { limits: { memory: '1Gi', cpu: '500m' }, requests: { memory: '128Mi', cpu: '50m' } },
  ingressPort: 80,
};

export const QDRANT_SPEC: AppSpec = {
  id: 'qdrant',
  image: 'qdrant/qdrant:latest',
  env: [
    { name: 'QDRANT__SERVICE__API_KEY', fromSecret: 'api_key', generate: 'password' },
    { name: 'QDRANT__LOG_LEVEL', value: 'INFO' },
  ],
  ports: [{ name: 'http', port: 6333 }, { name: 'grpc', port: 6334 }],
  volumes: [{ path: '/qdrant/storage', size: '50Gi' }],
  liveness: { path: '/healthz', port: 6333, initialDelaySeconds: 10, periodSeconds: 20 },
  readiness: { path: '/readyz', port: 6333, initialDelaySeconds: 5, periodSeconds: 10 },
  resources: { limits: { memory: '4Gi', cpu: '2000m' }, requests: { memory: '512Mi', cpu: '200m' } },
  ingressPort: 6333,
};

const SEARXNG_SETTINGS_YAML = [
  'use_default_settings: true',
  'server:',
  '  secret_key: "@SEARXNG_SECRET@"',
  '  limiter: false',
  '  image_proxy: false',
  'search:',
  '  formats:',
  '    - html',
  '    - json',
  '  default_lang: all',
  '',
].join('\n');

export const SEARXNG_SPEC: AppSpec = {
  id: 'searxng',
  image: 'searxng/searxng:latest',
  // A ConfigMap mount is read-only and the secret has to be substituted in — see configFiles below.
  command: ['/bin/sh', '-c'],
  args: [
    'cp /config-src/settings.yml /etc/searxng/settings.yml'
    + ' && sed -i "s|@SEARXNG_SECRET@|$SEARXNG_SECRET|" /etc/searxng/settings.yml'
    + ' && exec /usr/local/searxng/entrypoint.sh',
  ],
  env: [
    { name: 'SEARXNG_BIND_ADDRESS', value: '0.0.0.0' },
    { name: 'SEARXNG_PORT', value: '8080' },
    { name: 'SEARXNG_SECRET', fromSecret: 'secret_key', generate: 'password' },
  ],
  configFiles: [{ name: 'settings.yml', content: SEARXNG_SETTINGS_YAML, mountPath: '/config-src' }],
  ports: [{ name: 'http', port: 8080 }],
  liveness: { path: '/', port: 8080 },
  resources: { limits: { memory: '1Gi', cpu: '1000m' }, requests: { memory: '256Mi', cpu: '100m' } },
  ingressPort: 8080,
};

const VERDACCIO_CONFIG_YAML = [
  'storage: /verdaccio/storage',
  '',
  'uplinks:',
  '  npmjs:',
  '    url: https://registry.npmjs.org/',
  '    timeout: 30s',
  '    maxage: 2m',
  '    cache: true',
  '',
  'packages:',
  "  '@*/*':",
  '    access: $all',
  '    publish: $authenticated',
  '    proxy: npmjs',
  "  '**':",
  '    access: $all',
  '    publish: $authenticated',
  '    proxy: npmjs',
  '',
  'auth:',
  '  htpasswd:',
  '    file: /verdaccio/storage/htpasswd',
  '    max_users: -1',
  '',
  'log: { type: stdout, format: pretty-timestamped, level: warn }',
  '',
  'listen: 0.0.0.0:4873',
  '',
  'web:',
  '  enable: true',
  '  title: Koala package mirror',
  '',
].join('\n');

export const VERDACCIO_SPEC: AppSpec = {
  id: 'verdaccio',
  image: 'verdaccio/verdaccio:6',
  // A ConfigMap mount is read-only and Verdaccio rewrites its config on start — copy to a writable path first.
  command: ['/bin/sh', '-c'],
  args: [
    'mkdir -p /verdaccio/conf'
    + ' && cp /config-src/config.yaml /verdaccio/conf/config.yaml'
    + ' && exec verdaccio --config /verdaccio/conf/config.yaml',
  ],
  configFiles: [{ name: 'config.yaml', content: VERDACCIO_CONFIG_YAML, mountPath: '/config-src' }],
  ports: [{ name: 'http', port: 4873 }],
  volumes: [
    { path: '/verdaccio/storage', size: '20Gi' },
    // /verdaccio itself isn't writable in the image; this is where the conf copy above lands.
    { path: '/verdaccio/conf', type: 'ephemeral' },
  ],
  // The image runs as uid 10001 and writes to its storage directory — fsGroup is what makes the
  // mounted volume writable by that user.
  securityContext: { runAsUser: '10001', runAsGroup: '65533', fsGroup: '65533' },
  liveness: { path: '/-/ping', port: 4873, initialDelaySeconds: 20, periodSeconds: 20 },
  readiness: { path: '/-/ping', port: 4873, initialDelaySeconds: 10, periodSeconds: 10 },
  resources: { limits: { memory: '1Gi', cpu: '1000m' }, requests: { memory: '128Mi', cpu: '50m' } },
  ingressPort: 4873,
};

export const CRAWL4AI_SPEC: AppSpec = {
  id: 'crawl4ai',
  image: 'unclecode/crawl4ai:latest',
  env: [
    // With no credential the image binds 127.0.0.1 and refuses to expose itself at all.
    { name: 'CRAWL4AI_API_TOKEN', fromSecret: 'api_token', generate: 'password' },
    { name: 'CRAWL4AI_PORT', value: '11235' },
  ],
  ports: [{ name: 'http', port: 11235 }],
  // Memory-backed: Chromium renders an empty page (not an error) if /dev/shm is too small.
  volumes: [{ path: '/dev/shm', type: 'ephemeral', medium: 'Memory', size: '1Gi' }],
  // Every other route sits behind the auth gate and would 401 forever; /health is left public.
  liveness: { path: '/health', port: 11235 },
  resources: { limits: { memory: '4Gi', cpu: '2000m' }, requests: { memory: '512Mi', cpu: '200m' } },
  ingressPort: 11235,
};

/** New — not a migration of an existing construct. Needed as a companion-service target (see the plan's Stage 3). */
export const MARIADB_SPEC: AppSpec = {
  id: 'mariadb',
  image: 'mariadb:11',
  env: [{ name: 'MARIADB_ROOT_PASSWORD', fromSecret: 'root_password', generate: 'password' }],
  ports: [{ name: 'mysql', port: 3306 }],
  volumes: [{ path: '/var/lib/mysql', size: '10Gi' }],
  resources: { limits: { memory: '1Gi', cpu: '500m' }, requests: { memory: '256Mi', cpu: '100m' } },
};

/** New — not a migration of an existing construct. Needed as a companion-service target (see the plan's Stage 3). */
export const POSTGRES_SPEC: AppSpec = {
  id: 'postgres',
  image: 'postgres:16',
  env: [{ name: 'POSTGRES_PASSWORD', fromSecret: 'root_password', generate: 'password' }],
  ports: [{ name: 'postgres', port: 5432 }],
  volumes: [{ path: '/var/lib/postgresql/data', size: '10Gi' }],
  resources: { limits: { memory: '1Gi', cpu: '500m' }, requests: { memory: '256Mi', cpu: '100m' } },
};

export interface AppCatalogueMeta {
  label: string;
  is: string;
  provides: string[];
}

/** Display metadata, keyed by AppSpec id — kept separate from AppSpec itself since it describes the catalogue entry, not the deploy. */
export const APP_CATALOGUE_META: Record<string, AppCatalogueMeta> = {
  minio: { label: 'MinIO Object Storage', is: 'S3-compatible object storage', provides: ['object-storage', 'blob-storage', 'file-storage'] },
  jellyfin: { label: 'Jellyfin Media Server', is: 'a media server for video and music', provides: ['media'] },
  plex: { label: 'Plex Media Server', is: 'a media server for video and music', provides: ['media'] },
  navidrome: { label: 'Navidrome Music Server', is: 'a music streaming server', provides: ['media'] },
  kavita: { label: 'Kavita Digital Library', is: 'a comic and ebook reader', provides: ['media'] },
  immich: { label: 'Immich Photo & Video Backup', is: 'a photo and video library', provides: ['media', 'photos'] },
  homeassistant: { label: 'Home Assistant', is: 'a home automation hub', provides: ['home-automation'] },
  papra: { label: 'Papra Document Management', is: 'a document archive', provides: ['documents'] },
  audiobookshelf: { label: 'Audiobookshelf Media Server', is: 'an audiobook and podcast server', provides: ['media'] },
  qdrant: { label: 'Qdrant Vector Database', is: 'a vector database', provides: ['vector-search', 'similarity-search', 'embeddings-storage'] },
  mariadb: { label: 'MariaDB', is: 'a relational database', provides: ['database', 'mysql-compatible'] },
  postgres: { label: 'PostgreSQL', is: 'a relational database', provides: ['database', 'postgresql'] },
  searxng: { label: 'SearXNG (agent web search)', is: 'a metasearch engine', provides: ['web-search'] },
  verdaccio: { label: 'Verdaccio (private npm registry)', is: 'a private npm registry', provides: ['package-registry'] },
  crawl4ai: { label: 'Crawl4AI (agent page fetch)', is: 'a web crawler that returns clean page text', provides: ['web-crawl', 'scraping'] },
};

export interface StoredAppSpec {
  id: string;
  /** Absent for a custom spec a user proposed via chat — display code falls back to `id`/a generic description. */
  label?: string;
  is?: string;
  provides?: string[];
  spec: AppSpec;
  builtIn: boolean;
  ownerId?: string;
  editedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const BUILT_IN_SPECS: AppSpec[] = [
  MINIO_SPEC, JELLYFIN_SPEC, PLEX_SPEC, NAVIDROME_SPEC, KAVITA_SPEC, IMMICH_SPEC,
  HOMEASSISTANT_SPEC, PAPRA_SPEC, AUDIOBOOKSHELF_SPEC, QDRANT_SPEC, MARIADB_SPEC, POSTGRES_SPEC,
  SEARXNG_SPEC, VERDACCIO_SPEC, CRAWL4AI_SPEC,
];

export function specsToSeed(
  stored: readonly StoredAppSpec[],
  builtIn: readonly AppSpec[] = BUILT_IN_SPECS,
): AppSpec[] {
  const byId = new Map(stored.map((s) => [s.id, s]));
  return builtIn.filter((spec) => {
    const existing = byId.get(spec.id);
    if (!existing) return true;
    if (existing.editedAt) return false;
    const meta = APP_CATALOGUE_META[spec.id];
    return JSON.stringify(existing.spec) !== JSON.stringify(spec)
      || existing.label !== meta?.label
      || existing.is !== meta?.is
      || JSON.stringify(existing.provides) !== JSON.stringify(meta?.provides);
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
    const meta = APP_CATALOGUE_META[spec.id] ?? { label: spec.id, is: '', provides: [] };
    await store.saveAppSpec({
      id: spec.id,
      label: meta.label,
      is: meta.is,
      provides: meta.provides,
      spec,
      builtIn: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
  return pending.length;
}
