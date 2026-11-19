import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { DependencyStates } from './DependencyStates.js';
import { createDatabase, type Database } from '../lib/db-interface.js';
import { mongoTarget } from '../lib/mongo-target.js';
import { downAcross } from '../lib/dependencies.js';
import { testDatabase, TEST_DATA_KEY } from '../lib/test-database.js';
import { answersHttp, collectorAnswers, workerDependencies } from '../wiring/dependencies.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connectTemporalAs } from '../lib/temporal-client.js';
import { hostWorkerSettingsFrom } from '../lib/settings.js';
import { mongoClientFor } from '../lib/collection.js';
import { MongoPlatformStore } from '../store.js';
import { testIdentityKey, testKeyEnv } from '../testing/keys.js';
import { testDataDir } from '../testing/data-dir.js';
import { until } from '../testing/three-roles.js';
import { startMinio, testBucket, type RealMinio } from '../../files/testing/real-minio.js';
import { minioObjectStore, type ObjectStore } from '../../files/services/ObjectStore.js';
import { minioHealthUrl } from '../lib/dependencies.js';

const quiet = () => undefined;

describe('a dependency that stops answering and comes back', () => {
  let minio: RealMinio;
  let records: Database;

  beforeAll(async () => {
    minio = await startMinio({ port: await portToHandOn() });
    records = await testDatabase();
  });

  afterAll(async () => {
    await minio?.stop();
  });

  it('marks MinIO down with why when a call to it fails, records it for the backend to read, and marks it answering when it is back, however long that takes', async () => {
    const states = new DependencyStates({ process: 'worker-engine', described: ['minio'], record: (row) => records.platform.saveDependencyState(row), firstMs: 200, log: quiet });
    states.checkWith('minio', answersHttp(minioHealthUrl(minio.settings)));
    const store: ObjectStore = minioObjectStore({ ...minio.settings, bucket: testBucket() }, undefined, states);
    try {
      await states.start();
      expect(await store.stat('nothing-here')).toBeUndefined();
      expect(states.stateOf('minio')).toEqual({ state: 'answering' });

      await minio.halt();
      await expect(store.stat('nothing-here')).rejects.toThrow();
      const listing = async (): Promise<string[]> => {
        const ids: string[] = [];
        for await (const id of store.ids()) ids.push(id);
        return ids;
      };
      await expect(listing()).rejects.toThrow();
      const down = states.stateOf('minio');
      if (down.state !== 'down') throw new Error(`MinIO is stopped and still taken as answering`);
      expect(down.reason).toMatch(/^it refused the connection \(ECONNREFUSED\)$|^the connection to it was cut off/);
      const recorded = await until(async () => {
        const seen = downAcross([], await records.platform.dependencyStates());
        return seen.length ? seen : undefined;
      });
      expect(recorded).toEqual([{ dependency: 'minio', name: 'file storage (MinIO)', since: down.since, reason: down.reason, process: 'worker-engine' }]);

      await minio.resume();
      await until(async () => (states.stateOf('minio').state === 'answering' ? true : undefined));
      await until(async () => ((await records.platform.dependencyStates()).every((row) => row.state === 'answering') ? true : undefined));
      expect(downAcross([], await records.platform.dependencyStates())).toEqual([]);
    } finally {
      states.stop();
    }
  });
});

describe('the database stopping and starting again', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create({ instance: { replSet: 'rs0' } });
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('hears from the driver that Mongo is gone, says why, and that it is back once Mongo answers again', async () => {
    const uri = new URL(server.getUri());
    uri.pathname = '/dependencies';
    uri.searchParams.set('heartbeatFrequencyMS', '500');
    const db = createDatabase({ mongo: mongoTarget({ MONGO_URI: uri.toString() }), dataKey: TEST_DATA_KEY });
    const states = new DependencyStates({ process: 'backend', described: ['mongo'], firstMs: 200, log: quiet });
    db.reportReachTo(states);
    states.checkWith('mongo', () => db.ping());
    try {
      await db.init();
      await states.start();
      expect(states.stateOf('mongo')).toEqual({ state: 'answering' });

      await server.stop({ doCleanup: false });
      const down = await until(async () => {
        const state = states.stateOf('mongo');
        return state.state === 'down' ? state : undefined;
      });
      expect(down.reason).toMatch(/^it cannot be reached: |^it refused the connection|^the connection to it was cut off/);

      await server.start(true);
      await until(async () => (states.stateOf('mongo').state === 'answering' ? true : undefined));
      await db.ping();
    } finally {
      states.stop();
      await db.close();
    }
  });

  it('keeps what a worker saw while Mongo was gone and records it for the backend once Mongo answers again', async () => {
    const uri = new URL(server.getUri());
    uri.pathname = '/worker-dependencies';
    uri.searchParams.set('heartbeatFrequencyMS', '500');
    uri.searchParams.set('serverSelectionTimeoutMS', '500');
    const settings = hostWorkerSettingsFrom({
      NODE_ENV: 'development', ...testKeyEnv('worker-dependencies'), ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey(), MONGO_URI: uri.toString(),
      TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'), TEMPORAL_NAMESPACE: 'default', TEMPORAL_TLS_CA: inject('temporalCa'), DATA_DIR: testDataDir(),
      HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0', PUBLIC_URL: 'http://127.0.0.1:1', INSTANCE_IMAGE_TAG: 'test',
    });
    const reader = mongoClientFor(uri.toString());
    const temporalRow = async () => (await new MongoPlatformStore(() => reader.db()).dependencyStates()).find((row) => row.process === 'worker-host' && row.dependency === 'temporal');
    const outlasting = new URL(uri);
    outlasting.searchParams.set('serverSelectionTimeoutMS', '1000');
    const lateReader = mongoClientFor(outlasting.toString());
    const collector = createServer((_req, res) => { res.end(); });
    await new Promise<void>((listening) => collector.listen(0, '127.0.0.1', listening));
    const states = workerDependencies(settings, settings.mongo);
    states.checkWith('collector', collectorAnswers(() => `http://127.0.0.1:${(collector.address() as AddressInfo).port}`));
    try {
      await states.start();
      expect(await until(async () => ((await temporalRow())?.state === 'down' ? true : undefined))).toBe(true);

      await server.stop({ doCleanup: false });
      await until(async () => (states.stateOf('mongo').state === 'down' ? true : undefined));
      connectTemporalAs(settings);
      await until(async () => (states.stateOf('temporal').state === 'answering' ? true : undefined));
      await expect(new MongoPlatformStore(() => lateReader.db()).dependencyStates()).rejects.toThrow();

      await server.start(true);
      expect(await until(async () => ((await temporalRow())?.state === 'answering' ? true : undefined))).toBe(true);
    } finally {
      states.stop();
      await reader.close();
      await lateReader.close();
      await new Promise((closed) => collector.close(closed));
    }
  });
});

describe('a dependency reported on by its open connection', () => {
  it('is recorded answering at start, down and back as the connection says, and never checked by a timer', async () => {
    const records = await testDatabase();
    const states = new DependencyStates({ process: 'backend', described: ['root'], record: (row) => records.platform.saveDependencyState(row), firstMs: 50, log: quiet });
    states.toldByConnection('root');
    try {
      await states.start();
      await until(async () => ((await records.platform.dependencyStates()).some((row) => row.dependency === 'root' && row.state === 'answering') ? true : undefined));
      states.wentDown('root', 'this instance\'s connection to it is closed', new Date().toISOString());
      await until(async () => ((await records.platform.dependencyStates()).some((row) => row.dependency === 'root' && row.state === 'down') ? true : undefined));
      expect(states.stateOf('root')).toMatchObject({ state: 'down', reason: 'this instance\'s connection to it is closed' });
      states.answered('root');
      await until(async () => ((await records.platform.dependencyStates()).some((row) => row.dependency === 'root' && row.state === 'answering') ? true : undefined));
      expect(states.stateOf('root').state).toBe('answering');
    } finally {
      states.stop();
    }
  });
});
