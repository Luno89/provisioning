import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { temporal } from '@temporalio/proto';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { testMinioEnv } from './files/testing/real-minio.js';
import { testKeyEnv } from './platform/testing/keys.js';
import { unreachedPlatformServices } from './platform/testing/platform-services.js';
import { testDatabaseAt } from './platform/lib/test-database.js';
import { realTemporalEnvironment } from './workflows/testing/temporal-test-env.js';
import { QUEUES } from './platform/index.js';
import { testDataDir } from './platform/testing/data-dir.js';

let env: TestWorkflowEnvironment;
const from = process.cwd();
const homeWas = process.env.HOME;
let home = '';

beforeAll(async () => {
  env = await realTemporalEnvironment();
  const { uri, dbName } = await testDatabaseAt();
  const rootKey = Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64');
  Object.assign(process.env, testMinioEnv(), unreachedPlatformServices(), testKeyEnv('instance-boot'), {
    ROLE: 'instance', INSTANCE_ID: 'inst-boot', INSTANCE_OWNER_ID: 'owner-boot', ROOT_URL: 'http://127.0.0.1:1', ROOT_PUBLIC_KEYS: rootKey, INSTANCE_CREDENTIAL: 'cred', KOALA_RELEASE_REVISION: '1',
    PORT: '0', MACHINE_GATEWAY_PORT: '0', PUBLIC_URL: 'http://127.0.0.1:1', APP_URL: 'http://127.0.0.1:1', TRUST_PROXY: 'loopback', TERRAFORM_STATE: 'local',
    MONGO_URI: uri.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`),
    TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: env.namespace ?? 'default', TEMPORAL_TLS_CA: inject('temporalCa'), DATA_DIR: testDataDir(),
  });
  home = await mkdtemp(join(tmpdir(), 'koala-instance-boot-'));
  process.chdir(home);
  process.env.HOME = home;
});

afterAll(async () => {
  process.chdir(from);
  process.env.HOME = homeWas;
  await rm(home, { recursive: true, force: true });
  await env.teardown();
});

describe('an instance\'s backend, started as its entry starts it', () => {
  it('starts its own stream worker, which polls the stream queue', async () => {
    const { bootstrap } = await import('./index.js');
    await bootstrap();
    const pollers = async () => (await env.client.workflowService.describeTaskQueue({
      namespace: env.namespace ?? 'default', taskQueue: { name: QUEUES.stream }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 200));
    expect((await pollers()).length).toBeGreaterThan(0);
  });
});
