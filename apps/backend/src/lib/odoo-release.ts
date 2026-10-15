import { sanitiseNamespaceName } from './projects.js';
import type { ReleaseE2E } from './release-e2e.js';
import type { ClusterMetadata, ProjectMetadata } from './types.js';
import type { TreeTypeSecret } from './tree-types.js';

export type Slot = 'a' | 'b';

export const SLOTS: readonly Slot[] = ['a', 'b'];

export const idleOf = (live: Slot): Slot => (live === 'a' ? 'b' : 'a');

export const databaseOf = (slot: Slot): string => `odoo_${slot}`;

export const CHART_DIR = 'deploy/chart';
export const CHART_FILE = `${CHART_DIR}/Chart.yaml`;

export interface SlotState {
  installed: boolean;
  live: Slot;
  tags: Record<Slot, string | undefined>;
  previewHost?: string | undefined;
}

export const NOTHING_INSTALLED: SlotState = { installed: false, live: 'a', tags: { a: undefined, b: undefined } };

export type ReleaseState = 'queued' | 'preparing' | 'preview' | 'cutting-over' | 'live' | 'rolling-back' | 'rolled-back' | 'discarded' | 'failed' | 'superseded';

export interface OdooRelease {
  id: string;
  ownerId: string;
  projectId: string;
  pipelineRunId: string;
  commit: string;
  image: string;
  slot?: Slot | undefined;
  state: ReleaseState;
  host: string;
  previewHost?: string | undefined;
  reason?: string | undefined;
  e2e?: ReleaseE2E | undefined;
  liveAt?: string | undefined;
  replacedBy?: string | undefined;
  restoredAt?: string | undefined;
  startedAt: string;
  updatedAt: string;
}

export function rollBackTarget(releases: readonly OdooRelease[], live: OdooRelease): { to: OdooRelease } | { problem: string } {
  if (live.state !== 'live') return { problem: `the release is ${live.state}, not live` };
  const to = releases.find((release) => release.replacedBy === live.id && release.state === 'superseded');
  if (!to) return { problem: 'no earlier release is kept to go back to' };
  const later = releases.find((release) => release.projectId === live.projectId && release.startedAt > live.startedAt);
  if (later) return { problem: `the build of ${later.commit.slice(0, 8)} has taken the slot the earlier release was kept in` };
  return { to };
}

export const ODOO_PROJECT_APP = 'odoo-project';

const RELEASE_BASE_MAX = 40;

const shortHash = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, '0').slice(-6);
};

export function releaseNameOf(project: Pick<ProjectMetadata, 'name' | 'releaseName'>): string {
  return project.releaseName || sanitiseNamespaceName(project.name) || 'odoo';
}

export function newReleaseName(project: Pick<ProjectMetadata, 'id' | 'name'>): string {
  const base = (sanitiseNamespaceName(project.name) || 'odoo').slice(0, RELEASE_BASE_MAX).replace(/-+$/, '');
  return `${base}-${shortHash(project.id)}`;
}

export function releasePlace(name: string, domain = 'apps.local'): { namespace: string; release: string; host: string; previewHost: string } {
  return { namespace: name, release: name, host: `${name}.${domain}`, previewHost: `${name}-preview.${domain}` };
}

export interface ReleasePlaceOnCluster {
  clusterName: string;
  provider: string;
  gpuEnabled?: boolean | undefined;
  kubeconfigPath?: string | undefined;
  namespace: string;
  release: string;
  owner?: { ownerId: string; projectId: string } | undefined;
}

export function releaseTargetOf(
  cluster: Pick<ClusterMetadata, 'name' | 'provider' | 'gpuEnabled' | 'kubeconfigPath'>,
  project: Pick<ProjectMetadata, 'id' | 'name' | 'releaseName' | 'ownerId'>,
): ReleasePlaceOnCluster {
  const place = releasePlace(releaseNameOf(project));
  return {
    clusterName: cluster.name,
    provider: cluster.provider,
    ...(cluster.gpuEnabled ? { gpuEnabled: true } : {}),
    ...(cluster.kubeconfigPath ? { kubeconfigPath: cluster.kubeconfigPath } : {}),
    namespace: place.namespace,
    release: place.release,
    ...(project.ownerId ? { owner: { ownerId: project.ownerId, projectId: project.id } } : {}),
  };
}

export function splitImage(image: string): { repository: string; tag: string } {
  const at = image.lastIndexOf(':');
  if (at <= image.lastIndexOf('/')) throw new Error(`the image "${image}" has no tag`);
  return { repository: image.slice(0, at), tag: image.slice(at + 1) };
}

export function slotStateFrom(values: unknown): SlotState {
  if (!values || typeof values !== 'object') return NOTHING_INSTALLED;
  const given = values as { live?: unknown; slots?: Record<string, { tag?: unknown } | undefined>; previewHost?: unknown };
  const tag = (slot: Slot): string | undefined => {
    const value = given.slots?.[slot]?.tag;
    return typeof value === 'string' && value ? value : undefined;
  };
  return {
    installed: true,
    live: given.live === 'b' ? 'b' : 'a',
    tags: { a: tag('a'), b: tag('b') },
    ...(typeof given.previewHost === 'string' && given.previewHost ? { previewHost: given.previewHost } : {}),
  };
}

export function helmSets(input: { repository: string; state: SlotState; host: string; previewHost?: string | undefined }): string[] {
  const pairs: [string, string][] = [
    ['image.repository', input.repository],
    ['live', input.state.live],
    ['host', input.host],
    ['previewHost', input.previewHost ?? ''],
    ...SLOTS.map((slot): [string, string] => [`slots.${slot}.tag`, input.state.tags[slot] ?? '']),
  ];
  return pairs.flatMap(([key, value]) => ['--set-string', `${key}=${value}`]);
}

export function modulesIn(paths: readonly string[]): string[] {
  const found = paths
    .map((path) => /^addons\/([a-z0-9_]+)\/__manifest__\.py$/.exec(path)?.[1])
    .filter((name): name is string => Boolean(name));
  return [...new Set(found)].sort();
}

export const releaseLabels = (release: string): Record<string, string> => ({ 'app.kubernetes.io/name': 'odoo-project', 'app.kubernetes.io/instance': release });

export const ODOO_DATABASE_PASSWORD = 'POSTGRES_PASSWORD';

export const ODOO_RELEASE_SECRETS: TreeTypeSecret[] = [
  { key: ODOO_DATABASE_PASSWORD, source: 'generated', describe: 'The password Odoo uses to reach its own PostgreSQL.' },
  { key: 'ODOO_ADMIN_PASSWORD', source: 'generated', describe: 'The password of Odoo\'s admin user, set on every release.', signInAs: 'admin' },
];
export const OWN_SECRET_FILE = `${CHART_DIR}/templates/secret.yaml`;

export interface ReleaseVault {
  projectId: string;
  secret: string;
  keys: string[];
  database: { secret: string; key: string };
  adminKey?: string | undefined;
}

export const chartDatabaseSecret = (release: string): { secret: string; key: string } => ({ secret: `${release}-secrets`, key: 'postgres-password' });

export const vaultDatabaseSecret = (release: string): { secret: string; key: string } => ({ secret: `${release}-vault`, key: ODOO_DATABASE_PASSWORD });

export function databaseSecretFrom(vaultKeys: readonly string[], release: string): { secret: string; key: string } {
  return vaultKeys.includes(ODOO_DATABASE_PASSWORD) ? vaultDatabaseSecret(release) : chartDatabaseSecret(release);
}

export function setAdminPasswordScript(): string {
  return [
    'import os',
    "env.ref('base.user_admin').password = os.environ['ADMIN_PASSWORD']",
    'env.cr.commit()',
  ].join('\n');
}

export function odooJob(input: {
  name: string;
  release: string;
  image: string;
  database: string;
  install: readonly string[];
  update: readonly string[];
  vault?: ReleaseVault | undefined;
}): Record<string, unknown> {
  const args = [
    `--database=${input.database}`,
    ...(input.install.length ? [`--init=${input.install.join(',')}`] : []),
    ...(input.update.length ? [`--update=${input.update.join(',')}`] : []),
    '--stop-after-init',
    '--without-demo=all',
    '--data-dir=/var/lib/odoo',
    `--db_host=${input.release}-postgres`,
    '--db_user=odoo',
    '--db_password=$(PASSWORD)',
  ];
  const password = input.vault?.database ?? chartDatabaseSecret(input.release);
  const admin = input.vault?.adminKey ? { secret: input.vault.secret, key: input.vault.adminKey } : undefined;
  const shell = [
    'shell',
    `--database=${input.database}`,
    `--db_host=${input.release}-postgres`,
    '--db_user=odoo',
    '--db_password="$PASSWORD"',
    '--data-dir=/var/lib/odoo',
    '--no-http',
  ].join(' ');
  const run = admin
    ? { command: ['sh', '-c', `odoo "$@" && printf '%s\\n' "$SET_ADMIN" | odoo ${shell}`, 'odoo'], args }
    : { command: ['odoo'], args };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: input.name, labels: releaseLabels(input.release) },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: releaseLabels(input.release) },
        spec: {
          restartPolicy: 'Never',
          securityContext: { fsGroup: 101 },
          containers: [{
            name: 'odoo',
            image: input.image,
            ...run,
            env: [
              { name: 'PASSWORD', valueFrom: { secretKeyRef: { name: password.secret, key: password.key } } },
              ...(admin ? [
                { name: 'ADMIN_PASSWORD', valueFrom: { secretKeyRef: { name: admin.secret, key: admin.key } } },
                { name: 'SET_ADMIN', value: setAdminPasswordScript() },
              ] : []),
            ],
            volumeMounts: [{ name: 'filestore', mountPath: '/var/lib/odoo' }],
          }],
          volumes: [{ name: 'filestore', persistentVolumeClaim: { claimName: `${input.release}-filestore` } }],
        },
      },
    },
  };
}

export function filestoreJob(input: { name: string; release: string; image: string; from: string; to: string }): Record<string, unknown> {
  const script = `rm -rf /var/lib/odoo/filestore/${input.to} && if [ -d /var/lib/odoo/filestore/${input.from} ]; then cp -a /var/lib/odoo/filestore/${input.from} /var/lib/odoo/filestore/${input.to}; fi`;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: input.name, labels: releaseLabels(input.release) },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: releaseLabels(input.release) },
        spec: {
          restartPolicy: 'Never',
          securityContext: { fsGroup: 101 },
          containers: [{ name: 'copy', image: input.image, command: ['sh', '-c', script], volumeMounts: [{ name: 'filestore', mountPath: '/var/lib/odoo' }] }],
          volumes: [{ name: 'filestore', persistentVolumeClaim: { claimName: `${input.release}-filestore` } }],
        },
      },
    },
  };
}

export const copyDatabaseScript = (from: string, to: string): string =>
  `dropdb --if-exists -U odoo ${to} && createdb -U odoo ${to} && pg_dump -U odoo ${from} | psql -q -v ON_ERROR_STOP=1 -U odoo -d ${to} > /dev/null`;
