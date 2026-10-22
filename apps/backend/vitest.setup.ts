import { afterAll } from 'vitest';
import { closeTestDatabases } from './src/platform/lib/test-database.js';

afterAll(async () => {
  await closeTestDatabases();
});
