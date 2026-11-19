import type { Database } from '../../platform/index.js';

export const records: { db: Database | undefined } = { db: undefined };

export function withRecordedDatabase<Platform extends object>(platform: Platform): Platform & { createDatabase: () => Database } {
  return {
    ...platform,
    createDatabase: () => {
      if (!records.db) throw new Error('A test reached the database before giving it one');
      return records.db;
    },
  };
}
