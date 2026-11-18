import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE } from '@koala/engine-core/koala-install';
import type { ClusterAccess } from '../infrastructure/index.js';
import type { Database, DatabaseSettings, DependencyReporter, HostWorkerSettings } from '../platform/index.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { testKeys } from '../platform/testing/keys.js';
import { giveHostActivities } from './host-settings.js';

const opened = vi.hoisted(() => ({ db: undefined as Database | undefined }));

vi.mock('../platform/index.js', async (actual) => ({
  ...(await actual<typeof import('../platform/index.js')>()),
  createDatabase: (_settings: DatabaseSettings) => ({ ...opened.db!, close: async () => undefined }),
}));

const { PoolSetupActivity } = await import('./PoolActivities.js');

const pool = { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: 't', trialEndsAt: 't', settingUp: true };

async function world() {
  giveHostActivities({ mongo: { uri: 'mongodb://root-mongo', dbName: 'koala' }, keys: testKeys('pool-setup') } as unknown as HostWorkerSettings, mock<ClusterAccess>(), mock<DependencyReporter>());
  opened.db = memoryDatabase();
  await opened.db.instances.saveInstance({ id: 'inst-bo', ownerId: 'bo', name: 'bo', url: 'https://bo.koala.dev', status: 'installing', createdAt: 't', updatedAt: 't', pool });
  return async () => (await opened.db!.instances.getInstances('bo'))[0]!;
}

describe('a pool instance hearing its setup while it is placed', () => {
  it('shows each piece, and once the setup ends records it ready, or failed at its piece, and stops waiting for it', async () => {
    const record = await world();
    expect(await PoolSetupActivity({ instanceId: 'inst-bo', report: { revision: 1, progress: { stage: 'searxng', title: 'SearXNG, web search', state: 'started', line: 'waiting for deployment/searxng' } } })).toBeUndefined();
    expect(await record()).toMatchObject({ status: 'installing', detail: 'Koala is setting itself up: SearXNG, web search, waiting for deployment/searxng', pool: { settingUp: true }, setup: { revision: 1, state: 'running' } });
    expect(await PoolSetupActivity({ instanceId: 'inst-bo', report: { revision: 1, progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } } })).toBe('up');
    expect(await record()).toMatchObject({ status: 'ready', detail: 'Ready', setup: { state: 'up' } });
    expect((await record()).pool!.settingUp).toBeUndefined();
  });

  it('ends failed at the piece that stopped', async () => {
    const record = await world();
    expect(await PoolSetupActivity({ instanceId: 'inst-bo', report: { revision: 1, progress: { stage: 'infisical', title: 'Infisical, your secrets', state: 'failed', why: 'OOMKilled' } } })).toBe('failed');
    expect(await record()).toMatchObject({ status: 'failed', detail: 'Koala stopped setting itself up at Infisical, your secrets: OOMKilled' });
    expect((await record()).pool!.settingUp).toBeUndefined();
  });
});
