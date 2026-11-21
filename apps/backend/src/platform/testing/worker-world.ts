import { generateKeyPairSync } from 'node:crypto';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, inject } from 'vitest';
import { realTemporalEnvironment } from '../../workflows/testing/temporal-test-env.js';
import type { MongoDB } from '../lib/mongo-db.js';
import { testDatabaseAt } from '../lib/test-database.js';
import { testDataDir } from './data-dir.js';
import { testKeyEnv } from './keys.js';

export interface WorkerWorld {
  env: TestWorkflowEnvironment;
  db: MongoDB;
  mongoUri: string;
  rootKey: string;
  placed(name: string, role: 'root' | 'instance'): Record<string, string>;
}

export async function workerWorld(): Promise<WorkerWorld> {
  const env = await realTemporalEnvironment();
  afterAll(async () => { await env.teardown(); });
  const { uri, dbName, db } = await testDatabaseAt();
  const mongoUri = `${uri.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`)}`;
  const rootKey = Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64');
  return {
    env,
    db,
    mongoUri,
    rootKey,
    placed: (name, role) => ({
      NODE_ENV: 'development', ...testKeyEnv(name), ROLE: role, MONGO_URI: mongoUri,
      TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: env.namespace ?? 'default', TEMPORAL_TLS_CA: inject('temporalCa'), DATA_DIR: testDataDir(),
    }),
  };
}
