import { beforeAll, describe, expect, inject, it } from 'vitest';
import { hostWorkerSettingsFrom } from '../platform/index.js';
import { testIdentityKey, testKeyEnv } from '../platform/testing/keys.js';
import { testDatabaseAt } from '../platform/lib/test-database.js';
import { testDataDir } from '../platform/testing/data-dir.js';
import { dependencyStatesFor } from '../platform/wiring/dependencies.js';
import { giveHostActivities, hostClusterAccess } from './host-settings.js';
import { KoalaInstallAskActivity, KoalaInstallStageActivity } from './KoalaInstallActivities.js';
import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE } from '@koala/engine-core/koala-install';

let db: Awaited<ReturnType<typeof testDatabaseAt>>['db'];

beforeAll(async () => {
  const at = await testDatabaseAt();
  db = at.db;
  const settings = hostWorkerSettingsFrom({
    NODE_ENV: 'development', ...testKeyEnv('koala-install-host'), ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey(), MONGO_URI: at.uri.replace(/\/[^/?]*(\?|$)/, `/${at.dbName}$1`),
    TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: 'default', TEMPORAL_TLS_CA: inject('temporalCa'), DATA_DIR: testDataDir(),
    HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0', PUBLIC_URL: 'https://app.root.test', INSTANCE_IMAGE_TAG: 'v1',
  });
  giveHostActivities(settings, hostClusterAccess(settings), dependencyStatesFor(settings));
});

const record = async () => (await db.instances.getInstances('bo'))[0]!;

describe('the install workflow\'s activities as root\'s host worker runs them, on root\'s Mongo', () => {
  it('asks the machine, then records the stages it reports and Koala\'s setup until Koala is ready there, each time in the database the worker\'s settings name', async () => {
    await db.instances.saveInstance({ id: 'inst-bo', ownerId: 'bo', url: '', createdAt: 't', updatedAt: 't', machine: 'desk', machineId: 'desk', install: { id: 'install-1', machineId: 'desk', state: 'asked', at: 't', imageTag: 'v1' } });

    expect(await KoalaInstallAskActivity({ installId: 'install-1' })).toBe('asked');
    expect(await record()).toMatchObject({ status: 'installing', detail: 'Asking desk to put Koala on itself', install: { state: 'asked', askedAt: expect.any(String) as unknown } });
    expect(await KoalaInstallStageActivity({ installId: 'install-1', progress: { stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320' } })).toBe('installing');
    expect(await record()).toMatchObject({ status: 'installing', detail: 'Koala on desk is setting itself up', url: 'http://100.64.0.7:30320', install: { state: 'installing', koalaUp: true } });
    expect(await KoalaInstallStageActivity({ installId: 'install-1', setup: { revision: 1, progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } } })).toBe('ready');
    expect(await record()).toMatchObject({ status: 'ready', url: 'http://100.64.0.7:30320', running: 'v1', install: { state: 'ready' }, setup: { revision: 1, state: 'up' } });
    expect(await KoalaInstallAskActivity({ installId: 'install-0' })).toBe('replaced');
  });
});
