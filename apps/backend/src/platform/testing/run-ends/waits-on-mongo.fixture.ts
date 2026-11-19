import { expect, inject, it } from 'vitest';
import { leaseMongo } from '../../lib/mongo-lease.js';

it('waits on a Mongo that stops under it', async () => {
  const { client } = await leaseMongo(inject('mongoUri'));
  await client.db('admin').command({ shutdown: 1, force: true }).then(() => undefined, (gone: Error) => gone.message);
  await new Promise(() => undefined);
  expect(client).toBeUndefined();
});
