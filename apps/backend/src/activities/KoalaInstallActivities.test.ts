import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess } from '../infrastructure/index.js';
import { MemoryInstancesStore } from '../instances/testing/memory-store.js';
import type { InstanceRecord } from '../instances/index.js';
import type { Database, DatabaseSettings, DependencyReporter, HostWorkerSettings } from '../platform/index.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { testKeys } from '../platform/testing/keys.js';
import { giveHostActivities } from './host-settings.js';
import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE } from '@koala/engine-core/koala-install';

const opened = vi.hoisted(() => ({ settings: [] as unknown[], db: undefined as Database | undefined, closed: 0 }));

vi.mock('../platform/index.js', async (actual) => ({
  ...(await actual<typeof import('../platform/index.js')>()),
  createDatabase: (settings: DatabaseSettings) => {
    opened.settings.push(settings);
    return { ...opened.db!, close: async () => { opened.closed += 1; } };
  },
}));

const { koalaInstallActivities, KoalaInstallAskActivity, KoalaInstallStageActivity } = await import('./KoalaInstallActivities.js');

const AT = new Date('2026-11-18T10:00:00Z');

async function world(install: InstanceRecord['install']) {
  const instances = new MemoryInstancesStore();
  await instances.saveInstance({ id: 'inst-bo', ownerId: 'bo', url: '', createdAt: 't', updatedAt: 't', machine: 'desk', machineId: 'desk', credentialHash: 'h', install });
  let closed = 0;
  const activities = koalaInstallActivities({ db: async () => ({ db: { instances } as never, close: async () => { closed += 1; } }), now: () => AT });
  return { instances, activities, closed: () => closed, record: async () => (await instances.getInstances('bo'))[0]! };
}

describe('the install workflow\'s activities, with a store of records in memory', () => {
  it('asks the machine by stamping the ask, keeping what else the instance holds, and closes what it opened', async () => {
    const { activities, record, closed } = await world({ id: 'install-1', machineId: 'desk', state: 'asked', at: 't' });
    expect(await activities.KoalaInstallAskActivity({ installId: 'install-1' })).toBe('asked');
    expect(await record()).toMatchObject({ status: 'installing', detail: 'Asking desk to put Koala on itself', credentialHash: 'h', install: { state: 'asked', askedAt: AT.toISOString() } });
    expect(closed()).toBe(1);
  });

  it('records each stage it hears, and ends ready, with where Koala answers and what it runs, only once Koala has set itself up', async () => {
    const { activities, record } = await world({ id: 'install-1', machineId: 'desk', state: 'asked', at: 't', imageTag: 'v1' });
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'koala', title: 'Putting Koala', state: 'started', line: 'waiting for job/x runs' } })).toBe('installing');
    expect((await record()).install).toMatchObject({ state: 'installing', line: 'waiting for job/x runs' });
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'koala', title: 'Putting Koala', state: 'done', url: 'http://100.64.0.7:30320' } })).toBe('installing');
    expect(await record()).toMatchObject({ status: 'installing', detail: 'Koala on desk is setting itself up', url: 'http://100.64.0.7:30320' });
    expect((await record()).servedAt).toBeUndefined();
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', setup: { revision: 1, progress: { stage: 'monitoring', title: 'Monitoring', state: 'started', line: 'waiting for deployment/grafana' } } })).toBe('installing');
    expect(await record()).toMatchObject({ status: 'installing', detail: 'Koala on desk is setting itself up: Monitoring, waiting for deployment/grafana', setup: { revision: 1, state: 'running', stage: 'monitoring' } });
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', setup: { revision: 1, progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } } })).toBe('ready');
    expect(await record()).toMatchObject({ status: 'ready', url: 'http://100.64.0.7:30320', running: 'v1', servedAt: AT.toISOString(), setup: { revision: 1, state: 'up' } });
  });

  it('keeps nothing of a setup for a revision older than the one it has heard', async () => {
    const { activities, instances, record } = await world({ id: 'install-1', machineId: 'desk', state: 'installing', at: 't' });
    await instances.saveInstance({ ...(await record()), setup: { revision: 2, state: 'running', stage: 'gitea', title: 'Gitea', at: 't' } });
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', setup: { revision: 1, progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } } })).toBe('installing');
    expect(await record()).toMatchObject({ install: { state: 'installing' }, setup: { revision: 2, state: 'running' } });
  });

  it('changes nothing for an install that was replaced or has ended, saying so', async () => {
    const { activities, record } = await world({ id: 'install-1', machineId: 'desk', state: 'failed', at: 't', why: 'no room' });
    expect(await activities.KoalaInstallAskActivity({ installId: 'install-0' })).toBe('replaced');
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'koala', title: 'Koala', state: 'started' } })).toBe('failed');
    expect((await record()).install).toMatchObject({ state: 'failed', why: 'no room' });
  });
});

describe('the install workflow\'s activities on a move from Koala\'s servers', () => {
  const pool = { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: 't', trialEndsAt: 't' };

  async function moving() {
    const instances = new MemoryInstancesStore();
    await instances.saveInstance({
      id: 'inst-bo', ownerId: 'bo', name: 'bo', url: 'https://bo.koala.dev', status: 'ready', detail: 'Ready', createdAt: 't', updatedAt: 't', credentialHash: 'pool', meshIp: '100.64.0.1', pool,
      setup: { revision: 3, state: 'up', stage: 'set-up', title: 'Koala is set up', at: 't' },
      move: { state: 'joined', startedAt: 't', credentialHash: 'move', target: { machine: 'desk', meshIp: '100.64.0.7' } },
      install: { id: 'install-1', machineId: 'desk', state: 'asked', at: 't', move: true },
    });
    const activities = koalaInstallActivities({ db: async () => ({ db: { instances } as never, close: async () => undefined }), now: () => AT });
    return { activities, record: async () => (await instances.getInstances('bo'))[0]! };
  }

  it('names the machine the move goes to, and follows the setup of the Koala it moves to, not the pool copy\'s', async () => {
    const { activities, record } = await moving();
    expect(await activities.KoalaInstallAskActivity({ installId: 'install-1' })).toBe('asked');
    expect((await record()).move).toMatchObject({ state: 'joined', detail: 'Asking desk to move Koala onto itself' });
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', setup: { revision: 1, progress: { stage: 'gitea', title: 'Gitea', state: 'started' } } })).toBe('installing');
    expect((await record()).move).toMatchObject({ state: 'copying', detail: 'Koala on desk is setting itself up: Gitea', setup: { revision: 1, state: 'running' } });
    expect(await record()).toMatchObject({ status: 'ready', detail: 'Ready', url: 'https://bo.koala.dev', credentialHash: 'pool', setup: { revision: 3, state: 'up' } });
  });

  it('ends a move that is ready, or failed with why, naming the instance whose move it ends', async () => {
    const { activities, record } = await moving();
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'koala-moved', title: 'Starting Koala', state: 'done', url: 'http://100.64.0.7:30320' } })).toBe('installing');
    expect((await record()).move).toMatchObject({ state: 'copying', target: { machine: 'desk', meshIp: '100.64.0.7', url: 'http://100.64.0.7:30320' } });
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', setup: { revision: 1, progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } } })).toEqual({ instanceId: 'inst-bo', ended: 'ready' });
    expect((await record()).move).toMatchObject({ state: 'switching', detail: 'Switching your address to your machine' });
    expect(await record()).toMatchObject({ status: 'ready', url: 'https://bo.koala.dev', credentialHash: 'pool' });

    const failing = await moving();
    expect(await failing.activities.KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'keys', title: 'Bringing Koala\'s keys', state: 'failed', why: 'the pool copy did not answer' } }))
      .toEqual({ instanceId: 'inst-bo', ended: 'failed', why: 'Moving Koala to desk stopped at Bringing Koala\'s keys: the pool copy did not answer' });
    expect((await failing.record()).move).toMatchObject({ state: 'failed' });
  });

  it('records a move that was stopped as stopped, on the move, telling the move why, and leaves the pool copy serving', async () => {
    const { activities, record } = await moving();
    expect(await activities.KoalaInstallStoppedActivity({ installId: 'install-1' })).toEqual({ instanceId: 'inst-bo', ended: 'failed', why: 'Moving Koala to desk stopped: it was stopped before it finished' });
    expect(await record()).toMatchObject({
      status: 'ready', url: 'https://bo.koala.dev', credentialHash: 'pool',
      install: { state: 'failed', why: 'it was stopped before it finished' }, move: { state: 'failed', detail: 'Moving Koala to desk stopped: it was stopped before it finished' },
    });
    expect(await activities.KoalaInstallStoppedActivity({ installId: 'install-1' })).toBe('failed');
  });
});

describe('the install workflow\'s activities as the host worker runs them', () => {
  it('open the database the host worker\'s settings name, with its data key, stamp the time it is now, and close the database after each one', async () => {
    const keys = testKeys('koala-install-host');
    const settings = { mongo: { uri: 'mongodb://root-mongo', dbName: 'koala' }, keys } as unknown as HostWorkerSettings;
    giveHostActivities(settings, mock<ClusterAccess>(), mock<DependencyReporter>());
    opened.db = memoryDatabase();
    await opened.db.instances.saveInstance({ id: 'inst-bo', ownerId: 'bo', url: '', createdAt: 't', updatedAt: 't', machine: 'desk', machineId: 'desk', credentialHash: 'h', install: { id: 'install-1', machineId: 'desk', state: 'asked', at: 't' } });
    const before = Date.now();

    expect(await KoalaInstallAskActivity({ installId: 'install-1' })).toBe('asked');
    expect(await KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'koala', title: 'Putting Koala', state: 'started' } })).toBe('installing');

    expect(opened.settings).toEqual([{ mongo: settings.mongo, dataKey: keys.data }, { mongo: settings.mongo, dataKey: keys.data }]);
    expect(opened.closed).toBe(2);
    const askedAt = Date.parse((await opened.db.instances.getInstances('bo'))[0]!.install!.askedAt!);
    expect(askedAt).toBeGreaterThanOrEqual(before);
    expect(askedAt).toBeLessThanOrEqual(Date.now());
  });
});
