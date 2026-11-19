import { vi } from 'vitest';
import type { Database } from '../../platform/index.js';

export const records: { db: Database | undefined } = { db: undefined };

vi.mock('../../platform/index.js', async (actual) => ({
  ...(await actual<typeof import('../../platform/index.js')>()),
  createDatabase: () => {
    if (!records.db) throw new Error('A test reached the database before giving it one');
    return records.db;
  },
}));
