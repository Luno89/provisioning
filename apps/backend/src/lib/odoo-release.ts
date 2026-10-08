import { sanitiseNamespaceName } from './projects.js';

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

export type ReleaseState = 'preparing' | 'preview' | 'cutting-over' | 'live' | 'discarded' | 'failed' | 'superseded';

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
  startedAt: string;
  updatedAt: string;
}

export const releaseWorkflowId = (projectId: string): string => `odoo-release-${projectId}`;

export const ODOO_PROJECT_APP = 'odoo-project';

export function releasePlace(projectName: string, domain = 'apps.local'): { namespace: string; release: string; host: string; previewHost: string } {
  const namespace = sanitiseNamespaceName(projectName) || 'odoo';
  return { namespace, release: namespace, host: `${namespace}.${domain}`, previewHost: `${namespace}-preview.${domain}` };
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

const labels = (release: string) => ({ 'app.kubernetes.io/name': 'odoo-project', 'app.kubernetes.io/instance': release });

export function odooJob(input: {
  name: string;
  release: string;
  image: string;
  database: string;
  install: readonly string[];
  update: readonly string[];
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
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: input.name, labels: labels(input.release) },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: labels(input.release) },
        spec: {
          restartPolicy: 'Never',
          securityContext: { fsGroup: 101 },
          containers: [{
            name: 'odoo',
            image: input.image,
            command: ['odoo'],
            args,
            env: [{ name: 'PASSWORD', valueFrom: { secretKeyRef: { name: `${input.release}-secrets`, key: 'postgres-password' } } }],
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
    metadata: { name: input.name, labels: labels(input.release) },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: labels(input.release) },
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
