import { expect, inject, it } from 'vitest';
import { mongoClientFor } from '../../lib/collection.js';

it('waits on a Mongo that stops under it', async () => {
  const client = mongoClientFor(inject('mongoUri'));
  await client.db('admin').command({ shutdown: 1, force: true }).then(() => undefined, (gone: Error) => gone.message);
  await new Promise(() => undefined);
  expect(client).toBeUndefined();
});
