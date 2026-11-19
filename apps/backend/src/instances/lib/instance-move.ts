import type { InstanceRecord } from './instances.js';
import type { KubeObject } from './app-move.js';
import type { InstanceSetup } from './instance-setup.js';

export const MOVE_PARTS = ['keys', 'data', 'mongo', 'gitea-db', 'gitea-data', 'infisical-db', 'terraform-state', 'apps'] as const;
export type MovePart = typeof MOVE_PARTS[number];
export const isMovePart = (value: unknown): value is MovePart => typeof value === 'string' && (MOVE_PARTS as readonly string[]).includes(value);

export const MOVED_KEYS = ['SESSION_KEY', 'DATA_KEY', 'PAYLOAD_KEY', 'EGRESS_KEY'] as const;

const SKIPPED = ['temporal_payload_chunks'] as const;
export type SkippedCollection = (typeof SKIPPED)[number];
export const SKIPPED_COLLECTIONS: readonly string[] = SKIPPED;

export const MOVE_STATES = ['waiting', 'joined', 'copying', 'switching', 'failed'] as const;
export type MoveStateName = typeof MOVE_STATES[number];

export interface InstanceMove {
  state: MoveStateName;
  startedAt: string;
  detail?: string | undefined;
  credentialHash?: string | undefined;
  wasPaused?: boolean | undefined;
  target?: { machine?: string | undefined; meshIp?: string | undefined; url?: string | undefined } | undefined;
  setup?: InstanceSetup | undefined;
}

export const poolMoveWorkflowId = (instanceId: string): string => `pool-move-${instanceId}`;
export const MOVE_FINISHED = 'moveFinished';
export const MOVE_STOPPED = 'moveStopped';

export function moveProblem(instance: Pick<InstanceRecord, 'pool' | 'status' | 'name'> & { move?: InstanceMove | undefined }): string | undefined {
  if (!instance.pool || !instance.name) return 'only an instance on Koala\'s servers moves to a machine of its own';
  if (instance.status !== 'ready' && instance.status !== 'paused') return 'the instance is still being set up; move it once it runs';
  if (instance.move?.state === 'switching') return 'the instance is switching to its new machine already';
  return undefined;
}

export interface PostgresPlace {
  namespace: string;
  pod: string;
  users?: string | undefined;
}

export const MOVED_POSTGRES: Record<'gitea-db' | 'infisical-db', PostgresPlace> = {
  'gitea-db': { namespace: 'gitea', pod: 'gitea-postgresql-0' },
  'infisical-db': { namespace: 'infisical', pod: 'postgresql-0', users: 'app=infisical-standalone' },
};

export const GITEA_DATA = { namespace: 'gitea', deployment: 'gitea', container: 'gitea', claim: 'gitea-shared-storage', path: '/data' } as const;

const AS = 'if [ -n "${POSTGRES_POSTGRES_PASSWORD:-}" ]; then export PGPASSWORD="$POSTGRES_POSTGRES_PASSWORD" PGUSER=postgres; '
  + 'else export PGPASSWORD="${POSTGRES_PASSWORD:-$(cat "$POSTGRES_PASSWORD_FILE")}" PGUSER="$POSTGRES_USER"; fi; export PGHOST=127.0.0.1;';
export const PG_DUMP = `${AS} exec pg_dump -d "$POSTGRES_DATABASE" -Fc`;
const AS_SUPERUSER = 'export PGPASSWORD="${POSTGRES_POSTGRES_PASSWORD:-$(cat "$POSTGRES_POSTGRES_PASSWORD_FILE")}" PGUSER=postgres PGHOST=127.0.0.1;';
export const drained = (script: string): string => `${script}; s=$?; cat > /dev/null; exit $s`;
export const PG_RESTORE = drained(`${AS_SUPERUSER} psql -d postgres -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \\"$POSTGRES_DATABASE\\" WITH (FORCE);" -c "CREATE DATABASE \\"$POSTGRES_DATABASE\\" OWNER \\"$POSTGRES_USER\\";"`
  + ' && pg_restore --no-owner --no-acl --exit-on-error --role="$POSTGRES_USER" -d "$POSTGRES_DATABASE"');

const KEY_VALUE = /^[A-Za-z0-9+/=_-]{16,512}$/;

export function keysEnv(env: Readonly<Record<string, string | undefined>>): string | { error: string } {
  const lines: string[] = [];
  for (const name of MOVED_KEYS) {
    const value = env[name]?.trim();
    if (!value) return { error: `this instance has no ${name}` };
    if (!KEY_VALUE.test(value)) return { error: `${name} is not a key this move can carry` };
    lines.push(`${name}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface MovedSettings {
  keys: string | { error: string };
  registryPullHost: string;
  podNamespace: string | undefined;
}

export const movedSettingsFrom = (env: Readonly<Record<string, string | undefined>>): MovedSettings => ({
  keys: keysEnv(env),
  registryPullHost: env.REGISTRY_PULL_HOST?.trim() ?? '',
  podNamespace: env.POD_NAMESPACE?.trim() || undefined,
});

export function keysFromEnv(text: string): Record<string, string> | { error: string } {
  const found: Record<string, string> = {};
  for (const line of text.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const at = line.indexOf('=');
    const name = line.slice(0, at);
    const value = line.slice(at + 1);
    if (at < 1 || !(MOVED_KEYS as readonly string[]).includes(name) || !KEY_VALUE.test(value)) return { error: 'the keys that came over are not the keys a move carries' };
    found[name] = value;
  }
  const missing = MOVED_KEYS.filter((name) => !found[name]);
  return missing.length ? { error: `the keys that came over lack ${missing.join(', ')}` } : found;
}

export const MOVE_STEP_WORDS: Record<MovePart, string> = {
  keys: 'Bringing the instance\'s keys',
  data: 'Copying its settings and files',
  mongo: 'Copying its chats, projects and records',
  'gitea-db': 'Copying its repositories\' records',
  'gitea-data': 'Copying its repositories and images',
  'infisical-db': 'Copying its secrets',
  'terraform-state': 'Copying what Terraform knows of its apps',
  apps: 'Stopping its apps to copy them',
};

export const answersWhileMoving = (path: string): boolean =>
  path.startsWith('/move/') || path.startsWith('/instance-trial') || path === '/auth/me' || path === '/auth/sign-in';

export const TERRAFORM_STATE_SELECTOR = 'tfstate=true';

export function movedStateSecrets(listed: { items?: KubeObject[] | undefined }): KubeObject[] {
  return (listed.items ?? [])
    .filter((item) => item.kind === 'Secret' && item.metadata?.name && item.metadata.labels?.tfstate === 'true')
    .map((item) => ({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: item.metadata!.name!, labels: item.metadata!.labels! },
      ...(item.type ? { type: item.type } : {}),
      data: item.data ?? {},
    }))
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}
