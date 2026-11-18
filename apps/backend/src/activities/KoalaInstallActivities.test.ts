import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess } from '../infrastructure/index.js';
import { MemoryInstancesStore } from '../instances/testing/memory-store.js';
import type { InstanceRecord } from '../instances/index.js';
import type { Database, DatabaseSettings, DependencyReporter, HostWorkerSettings } from '../platform/index.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { testKeys } from '../platform/testing/keys.js';
import { giveHostActivities } from './host-settings.js';

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

  it('records each stage it hears and ends ready, with where Koala answers and what it runs', async () => {
    const { activities, record } = await world({ id: 'install-1', machineId: 'desk', state: 'asked', at: 't', imageTag: 'v1' });
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'koala', title: 'Putting Koala', state: 'started', line: 'waiting for job/x runs' } })).toBe('installing');
    expect((await record()).install).toMatchObject({ state: 'installing', line: 'waiting for job/x runs' });
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'koala', title: 'Putting Koala', state: 'done', url: 'http://100.64.0.7:30320' } })).toBe('ready');
    expect(await record()).toMatchObject({ status: 'ready', url: 'http://100.64.0.7:30320', running: 'v1', servedAt: AT.toISOString() });
  });

  it('changes nothing for an install that was replaced or has ended, saying so', async () => {
    const { activities, record } = await world({ id: 'install-1', machineId: 'desk', state: 'failed', at: 't', why: 'no room' });
    expect(await activities.KoalaInstallAskActivity({ installId: 'install-0' })).toBe('replaced');
    expect(await activities.KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'koala', title: 'Koala', state: 'started' } })).toBe('failed');
    expect((await record()).install).toMatchObject({ state: 'failed', why: 'no room' });
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
