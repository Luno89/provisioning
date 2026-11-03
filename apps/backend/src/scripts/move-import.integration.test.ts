import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { testDatabaseAt } from '../platform/lib/test-database.js';
import { restoreMongoInto } from './move-import.js';

describe('the move\'s Mongo step on the new machine', () => {
  it('restores what root carried into this machine\'s Mongo and leaves no connection open', async () => {
    const { db, uri, dbName } = await testDatabaseAt();
    const carried = [{ c: 'projects', d: { _id: 'p1', id: 'p1', name: 'Shop', ownerId: 'bo', createdAt: 't' } }].map((line) => `${JSON.stringify(line)}\n`).join('');
    const said: string[] = [];
    expect(await restoreMongoInto({ uri, dbName }, Readable.from([zlib.gzipSync(carried)]), (line) => said.push(line))).toBe(1);
    expect((await db.projects.getProjects()).map((project) => project.name)).toEqual(['Shop']);
    expect(said).toEqual([]);
  });
});
