import { BSON, type Db, type Document } from 'mongodb';
import { SKIPPED_COLLECTIONS } from './instance-move.js';

const BATCH = 500;

export async function* exportLines(db: Db): AsyncGenerator<string> {
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('system.') && !SKIPPED_COLLECTIONS.includes(name))
    .sort();
  for (const name of collections) {
    for await (const doc of db.collection(name).find({})) {
      yield `${JSON.stringify({ c: name, d: BSON.EJSON.serialize(doc, { relaxed: false }) })}\n`;
    }
  }
}

export async function importLines(lines: AsyncIterable<string>, db: Db): Promise<number> {
  await db.dropDatabase();
  let collection = '';
  let batch: Document[] = [];
  let count = 0;
  const flush = async () => {
    if (batch.length) await db.collection(collection).insertMany(batch, { ordered: false });
    count += batch.length;
    batch = [];
  };
  for await (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { c: string; d: Document };
    if (entry.c !== collection) {
      await flush();
      collection = entry.c;
    }
    batch.push(BSON.EJSON.deserialize(entry.d, { relaxed: false }) as Document);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return count;
}
