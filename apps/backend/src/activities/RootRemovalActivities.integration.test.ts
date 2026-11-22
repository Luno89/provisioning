import { beforeAll, describe, expect, inject, it } from 'vitest';
import { hostWorkerSettingsFrom } from '../platform/index.js';
import { testIdentityKey, testKeyEnv } from '../platform/testing/keys.js';
import { testDatabaseAt } from '../platform/lib/test-database.js';
import { testDataDir } from '../platform/testing/data-dir.js';
import { dependencyStatesFor } from '../platform/wiring/dependencies.js';
import { giveHostActivities, hostClusterAccess } from './host-settings.js';
import { RootRemovalInstanceActivity, RootRemovalMachinesActivity, RootRemovalRecordsActivity } from './RootRemovalActivities.js';

let db: Awaited<ReturnType<typeof testDatabaseAt>>['db'];

beforeAll(async () => {
  const at = await testDatabaseAt();
  db = at.db;
  const settings = hostWorkerSettingsFrom({
    NODE_ENV: 'development', ...testKeyEnv('root-removal-host'), ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey(), MONGO_URI: at.uri.replace(/\/[^/?]*(\?|$)/, `/${at.dbName}$1`),
    TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: 'default', TEMPORAL_TLS_CA: inject('temporalCa'), DATA_DIR: testDataDir(),
    HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0', PUBLIC_URL: 'https://app.root.test', INSTANCE_IMAGE_TAG: 'v1',
  });
  giveHostActivities(settings, hostClusterAccess(settings), dependencyStatesFor(settings));
});

const instance = (ownerId: string, over: Record<string, unknown>) => ({ id: `inst-${ownerId}`, ownerId, url: '', createdAt: 't', updatedAt: 't', credentialHash: 'h', ...over }) as never;

describe('removing an account on root, as root\'s host worker runs it on root\'s Mongo', () => {
  it('names the install of Koala on the person\'s machine still under way, which the removal stops first', async () => {
    await db.instances.saveInstance(instance('bo', { machineId: 'desk', install: { id: 'install-bo', machineId: 'desk', state: 'installing', at: 't' } }));
    await db.instances.saveInstance(instance('cy', { machineId: 'desk', install: { id: 'install-cy', machineId: 'desk', state: 'ready', at: 't' } }));

    expect(await RootRemovalInstanceActivity({ ownerId: 'bo' })).toEqual({ installId: 'install-bo' });
    expect(await RootRemovalInstanceActivity({ ownerId: 'nobody' })).toEqual({});
  });

  it('names the person\'s own Koala that serves them, whose removal of its owner root waits for, and no Koala that never served', async () => {
    await db.instances.saveInstance(instance('cy', { machineId: 'desk', install: { id: 'install-cy', machineId: 'desk', state: 'ready', at: 't' } }));
    await db.instances.saveInstance(instance('fay', { status: 'waiting' }));

    expect(await RootRemovalInstanceActivity({ ownerId: 'cy' })).toEqual({ koala: 'inst-cy' });
    expect(await RootRemovalInstanceActivity({ ownerId: 'fay' })).toEqual({});
  });

  it('marks each of the person\'s machines for its uninstall and names them, and no one else\'s', async () => {
    await db.machines.saveLocalAgentDevice({ id: 'eve-desk', ownerId: 'eve', name: 'Desk', rootDir: '/home/eve/koala', createdAt: 't' });
    await db.machines.saveLocalAgentDevice({ id: 'gus-desk', ownerId: 'gus', name: 'Gus desk', rootDir: '/home/gus/koala', createdAt: 't' });

    expect(await RootRemovalMachinesActivity({ ownerId: 'eve' })).toEqual([{ id: 'eve-desk', name: 'Desk' }]);
    const devices = await db.machines.getLocalAgentDevices();
    expect(devices.find((device) => device.id === 'eve-desk')?.removal?.startedAt).toEqual(expect.any(String));
    expect(devices.find((device) => device.id === 'gus-desk')?.removal).toBeUndefined();
  });

  it('removes what the person owns on root, their account last, and says how many of each it removed', async () => {
    await db.accounts.saveUser({ id: 'dee', email: 'dee@root.test', createdAt: '2026-10-01T00:00:00Z' } as never);
    await db.instances.saveInstance(instance('dee', {}));

    const removed = await RootRemovalRecordsActivity({ ownerId: 'dee' });

    expect(removed).toMatchObject({ instances: 1, users: 1 });
    expect(await db.accounts.getUserById('dee')).toBeUndefined();
    expect(await db.instances.getInstances('dee')).toEqual([]);
  });
});
