import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { MongoDB } from './mongo-db.js';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

const open: MongoDB[] = [];

export async function testDatabase(): Promise<MongoDB> {
  const base = inject('mongoUri');
  const db = new MongoDB({ MONGO_URI: `${base}t_${randomUUID().replace(/-/g, '').slice(0, 20)}` });
  await db.init();
  open.push(db);
  return db;
}

export async function closeTestDatabases(): Promise<void> {
  const closing = open.splice(0, open.length);
  for (const db of closing) {
    await db.dropDatabase();
    await db.close();
  }
}
