import { randomUUID } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import { closeTestDatabases } from './src/platform/lib/test-database.js';

process.env.MONGO_URI = `${inject('mongoUri')}t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

afterAll(async () => {
  await closeTestDatabases();
});
