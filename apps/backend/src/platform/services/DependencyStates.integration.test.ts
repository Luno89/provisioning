import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { DependencyStates } from './DependencyStates.js';
import { createDatabase, type Database } from '../lib/db-interface.js';
import { mongoTarget } from '../lib/mongo-target.js';
import { downAcross } from '../lib/dependencies.js';
import { testDatabase, TEST_DATA_KEY } from '../lib/test-database.js';
import { answersHttp } from '../wiring/dependencies.js';
import { until, waiting } from '../testing/three-roles.js';
import { startMinio, testBucket, type RealMinio } from '../../files/testing/real-minio.js';
import { minioObjectStore, type ObjectStore } from '../../files/services/ObjectStore.js';

const quiet = () => undefined;

describe('a dependency that stops answering and comes back', () => {
  let minio: RealMinio;
  let records: Database;

  beforeAll(async () => {
    minio = await startMinio(undefined, { port: await portToHandOn() });
    records = await testDatabase();
  });

  afterAll(async () => {
    await minio?.stop();
  });

  it('marks MinIO down with why when a call to it fails, records it for the backend to read, and marks it answering when it is back, however long that takes', async () => {
    const states = new DependencyStates({ process: 'worker-engine', described: ['minio'], record: (row) => records.platform.saveDependencyState(row), firstMs: 200, log: quiet });
    const { endPoint, port } = minio.settings;
    states.checkWith('minio', answersHttp(`http://${endPoint}:${port}/minio/health/live`));
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
      const recorded = await until('the database to record MinIO as down', async () => {
        const rows = await records.platform.dependencyStates();
        const seen = downAcross([], rows);
        return seen.length ? seen : waiting(`${rows.length} rows recorded: ${rows.map((row) => `${row.dependency} ${row.state}`).join(', ')}`);
      });
      expect(recorded).toEqual([{ dependency: 'minio', name: 'file storage (MinIO)', since: down.since, reason: down.reason, process: 'worker-engine' }]);

      await minio.resume();
      await until('MinIO to be taken as answering', async () => {
        const state = states.stateOf('minio').state;
        return state === 'answering' ? true : waiting(`MinIO is ${state}`);
      });
      await until('every recorded dependency to answer', async () => {
        const notYet = (await records.platform.dependencyStates()).filter((row) => row.state !== 'answering');
        return notYet.length === 0 ? true : waiting(notYet.map((row) => `${row.dependency} ${row.state}`).join(', '));
      });
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
      const down = await until<{ state: 'down'; since: string; reason: string }>('Mongo to be taken as down', async () => {
        const state = states.stateOf('mongo');
        return state.state === 'down' ? state : waiting(`Mongo is ${state.state}`);
      });
      expect(down.reason).toMatch(/^it cannot be reached: |^it refused the connection|^the connection to it was cut off/);

      await server.start(true);
      await until('Mongo to be taken as answering', async () => {
        const state = states.stateOf('mongo').state;
        return state === 'answering' ? true : waiting(`Mongo is ${state}`);
      });
      await db.ping();
    } finally {
      states.stop();
      await db.close();
    }
  });
});

describe('a dependency reported on by its open connection', () => {
  it('is recorded answering at start, down and back as the connection says, and never checked by a timer', async () => {
    const records = await testDatabase();
    const states = new DependencyStates({ process: 'backend', described: ['root'], record: (row) => records.platform.saveDependencyState(row), firstMs: 50, log: quiet });
    states.toldByConnection('root');
    const rootRecorded = async (wanted: string) => {
      const rows = (await records.platform.dependencyStates()).filter((row) => row.dependency === 'root');
      return rows.some((row) => row.state === wanted) ? true : waiting(`root is recorded ${rows.map((row) => row.state).join(', ') || 'nowhere'}, wants ${wanted}`);
    };
    try {
      await states.start();
      await until('root to be recorded answering', async () => rootRecorded('answering'));
      states.wentDown('root', 'this instance\'s connection to it is closed', new Date().toISOString());
      await until('root to be recorded down', async () => rootRecorded('down'));
      expect(states.stateOf('root')).toMatchObject({ state: 'down', reason: 'this instance\'s connection to it is closed' });
      states.answered('root');
      await until('root to be recorded answering again', async () => rootRecorded('answering'));
      expect(states.stateOf('root').state).toBe('answering');
    } finally {
      states.stop();
    }
  });
});
